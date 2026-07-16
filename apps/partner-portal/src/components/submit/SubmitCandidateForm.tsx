"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { z } from "zod";
import { Button, Input } from "@hireops/ui";
import { useSearchParams } from "next/navigation";
import type {
  PartnerAssignedRequisitionRow,
  PartnerSubmitCandidateOutput,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Card, Badge } from "@/components/ui";

/**
 * SubmitCandidateForm (PARTNER-02) — the partner submits a candidate against
 * an assigned req. Mirrors the internal apply form's upload-then-reference
 * flow (POST /api/upload/resume, then the tRPC mutation) but on the
 * authenticated partner tier. Three-part surface, faithful to
 * partner-wireflows §3.5: pick a req + candidate details → attest consent +
 * ownership → the three dedup outcomes.
 *
 * Consent copy is the wireflows' verbatim attestation; the ownership
 * acknowledgement is its own required checkbox (the "you claim ownership …
 * 90-day window starts now" statement).
 */

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const ALLOWED_RESUME_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
// Versioned so a claim/candidate row records which consent text was attested.
const PARTNER_CONSENT_VERSION = "partner-msa-v1-2026-05";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/trpc$/, "") ??
  "http://localhost:3001";

function normalisePhoneForSubmit(raw: string): string {
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed.replace(/[\s-]/g, ""))) {
    return trimmed.replace(/[\s-]/g, "");
  }
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  return trimmed;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const fieldSchema = z.object({
  requisitionId: z.string().uuid("Choose a requisition"),
  fullName: z.string().trim().min(1, "Required").max(200),
  email: z.string().trim().email("Enter a valid email"),
  phone: z
    .string()
    .trim()
    .min(8, "Enter a valid phone number")
    .max(40)
    .refine((v) => /^\+?\d[\d\s-]{7,}$/.test(v), "Digits only, with or without country code"),
  linkedinUrl: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^https?:\/\/.+/i.test(v), "Must start with http:// or https://"),
  currentCompany: z.string().trim().max(200).optional(),
  currentTitle: z.string().trim().max(200).optional(),
  noteToRecruiter: z.string().trim().max(500).optional(),
  resume: z
    .instanceof(File, { message: "Choose the candidate's CV" })
    .refine((f) => f.size <= MAX_RESUME_BYTES, "File must be ≤ 10 MB")
    .refine((f) => ALLOWED_RESUME_MIME.has(f.type), "PDF or DOCX only"),
  consentAttested: z.literal(true, { message: "All three consent statements must be confirmed" }),
  ownershipAcknowledged: z.literal(true, { message: "The ownership acknowledgement is required" }),
});

type FieldErrors = Partial<Record<keyof z.infer<typeof fieldSchema>, string>>;

export function SubmitCandidateForm({ reqs }: { reqs: PartnerAssignedRequisitionRow[] }) {
  const searchParams = useSearchParams();
  const preselectReq = searchParams.get("req");
  const initialReqId = useMemo(() => {
    if (preselectReq && reqs.some((r) => r.requisitionId === preselectReq)) return preselectReq;
    const only = reqs.length === 1 ? reqs[0] : undefined;
    return only ? only.requisitionId : "";
  }, [preselectReq, reqs]);

  const [requisitionId, setRequisitionId] = useState(initialReqId);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [currentCompany, setCurrentCompany] = useState("");
  const [currentTitle, setCurrentTitle] = useState("");
  const [noteToRecruiter, setNoteToRecruiter] = useState("");
  const [resume, setResume] = useState<File | null>(null);
  const [consentAttested, setConsentAttested] = useState(false);
  const [ownershipAcknowledged, setOwnershipAcknowledged] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitState, setSubmitState] = useState<
    | { kind: "idle" }
    | { kind: "uploading" }
    | { kind: "submitting" }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });
  const [result, setResult] = useState<PartnerSubmitCandidateOutput | null>(null);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const submitMutation = trpc.partnerSubmitCandidate.useMutation();
  const isBusy = submitState.kind === "uploading" || submitState.kind === "submitting";

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setResume(e.target.files?.[0] ?? null);
    setFieldErrors((p) => ({ ...p, resume: undefined }));
  }

  function resetForm() {
    setResult(null);
    setSubmitState({ kind: "idle" });
    setFullName("");
    setEmail("");
    setPhone("");
    setLinkedinUrl("");
    setCurrentCompany("");
    setCurrentTitle("");
    setNoteToRecruiter("");
    setResume(null);
    setConsentAttested(false);
    setOwnershipAcknowledged(false);
    setFieldErrors({});
  }

  const selectedReq = reqs.find((r) => r.requisitionId === requisitionId) ?? null;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    const parsed = fieldSchema.safeParse({
      requisitionId,
      fullName,
      email,
      phone,
      linkedinUrl: linkedinUrl || undefined,
      currentCompany: currentCompany || undefined,
      currentTitle: currentTitle || undefined,
      noteToRecruiter: noteToRecruiter || undefined,
      resume,
      consentAttested,
      ownershipAcknowledged,
    });
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FieldErrors | undefined;
        if (key && !errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitState({ kind: "uploading" });
    let storageKey: string;
    try {
      const fd = new FormData();
      fd.append("file", parsed.data.resume);
      const res = await fetch(`${API_BASE}/api/upload/resume`, { method: "POST", body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      storageKey = ((await res.json()) as { storageKey: string }).storageKey;
    } catch (err) {
      setSubmitState({
        kind: "error",
        msg: err instanceof Error ? err.message : "Resume upload failed",
      });
      return;
    }

    setSubmitState({ kind: "submitting" });
    try {
      const out = await submitMutation.mutateAsync({
        requisitionId: parsed.data.requisitionId,
        resumeUploadKey: storageKey,
        candidate: {
          fullName: parsed.data.fullName,
          email: parsed.data.email,
          phone: normalisePhoneForSubmit(parsed.data.phone),
          locationCountry: "IN",
          linkedinUrl: parsed.data.linkedinUrl,
          currentCompany: parsed.data.currentCompany,
          currentTitle: parsed.data.currentTitle,
          noteToRecruiter: parsed.data.noteToRecruiter,
        },
        consentAttested: true,
        ownershipAcknowledged: true,
        consentVersion: PARTNER_CONSENT_VERSION,
      });
      setResult(out);
      setSubmitState({ kind: "idle" });
    } catch (err) {
      handleTRPCError(err);
      setSubmitState({
        kind: "error",
        msg: err instanceof Error ? err.message : "Submission failed",
      });
    }
  }

  if (result) {
    return <OutcomeCard result={result} onAnother={resetForm} />;
  }

  if (reqs.length === 0) {
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-neutral-900">No requisitions assigned yet</h2>
        <p className="text-sm text-neutral-500">
          You can submit candidates only against roles Kyndryl has opened to your organisation. None
          are open right now.
        </p>
      </Card>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-6"
      aria-label="Submit a candidate"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
          Submit a candidate
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Upload the CV, confirm the details, attest consent, and submit against an assigned req.
        </p>
      </div>

      {/* Step 1 — requisition */}
      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-800">Requisition</h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="req" className="text-sm font-medium text-neutral-700">
            For which role?
          </label>
          <select
            id="req"
            name="req"
            value={requisitionId}
            onChange={(e) => setRequisitionId(e.target.value)}
            aria-invalid={fieldErrors.requisitionId ? true : undefined}
            className="min-h-[44px] w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Select a requisition…</option>
            {reqs.map((r) => (
              <option key={r.requisitionId} value={r.requisitionId}>
                {r.title}
                {r.location ? ` · ${r.location}` : ""}
              </option>
            ))}
          </select>
          {fieldErrors.requisitionId && (
            <p className="text-sm text-status-error-700">{fieldErrors.requisitionId}</p>
          )}
        </div>
      </Card>

      {/* Step 2 — candidate details */}
      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-neutral-800">Candidate details</h2>
        <Input
          label="Full name"
          type="text"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={fieldErrors.fullName}
        />
        <Input
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />
        <Input
          label="Phone"
          type="tel"
          required
          hint="10 digits (we&rsquo;ll add +91) or full international format."
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={fieldErrors.phone}
        />
        <Input
          label="LinkedIn (optional)"
          type="text"
          placeholder="https://www.linkedin.com/in/…"
          value={linkedinUrl}
          onChange={(e) => setLinkedinUrl(e.target.value)}
          error={fieldErrors.linkedinUrl}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Current company (optional)"
            type="text"
            value={currentCompany}
            onChange={(e) => setCurrentCompany(e.target.value)}
            error={fieldErrors.currentCompany}
          />
          <Input
            label="Current title (optional)"
            type="text"
            value={currentTitle}
            onChange={(e) => setCurrentTitle(e.target.value)}
            error={fieldErrors.currentTitle}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="note" className="text-sm font-medium text-neutral-700">
            Note to recruiter (optional)
          </label>
          <textarea
            id="note"
            name="note"
            rows={3}
            maxLength={500}
            value={noteToRecruiter}
            onChange={(e) => setNoteToRecruiter(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Resume */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="resume" className="text-sm font-medium text-neutral-700">
            CV<span className="ml-1 text-status-error-500">*</span>
          </label>
          <input
            id="resume"
            name="resume"
            type="file"
            accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={onFileChange}
            aria-invalid={fieldErrors.resume ? true : undefined}
            className="block min-h-[44px] w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 file:mr-3 file:rounded file:border-0 file:bg-brand-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
          />
          {fieldErrors.resume ? (
            <p className="text-sm text-status-error-700">{fieldErrors.resume}</p>
          ) : (
            <p className="text-sm text-neutral-500">
              {resume ? resume.name : "PDF or DOCX, up to 10 MB."}
            </p>
          )}
        </div>
      </Card>

      {/* Step 3 — consent + ownership */}
      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-neutral-800">Consent &amp; ownership</h2>
        <label htmlFor="consent" className="flex items-start gap-3 text-sm text-neutral-700">
          <input
            id="consent"
            name="consent"
            type="checkbox"
            checked={consentAttested}
            onChange={(e) => setConsentAttested(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500"
          />
          <span>
            I confirm that I have obtained explicit, DPDPA-compliant consent from this candidate to
            share their CV and personal details with Kyndryl to evaluate their candidacy; that the
            candidate has been informed their data may be processed and retained by Kyndryl with
            rights of access, correction, and erasure; and that the information in this submission
            is accurate to the best of my knowledge.
          </span>
        </label>
        {fieldErrors.consentAttested && (
          <p className="ml-8 text-sm text-status-error-700">{fieldErrors.consentAttested}</p>
        )}
        <label htmlFor="ownership" className="flex items-start gap-3 text-sm text-neutral-700">
          <input
            id="ownership"
            name="ownership"
            type="checkbox"
            checked={ownershipAcknowledged}
            onChange={(e) => setOwnershipAcknowledged(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500"
          />
          <span>
            By submitting, I claim ownership of this candidate per Kyndryl&rsquo;s MSA Section 4.2.
            The 90-day exclusivity window starts now if this submission is accepted.
          </span>
        </label>
        {fieldErrors.ownershipAcknowledged && (
          <p className="ml-8 text-sm text-status-error-700">{fieldErrors.ownershipAcknowledged}</p>
        )}
      </Card>

      {submitState.kind === "error" && (
        <div
          role="alert"
          className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800"
        >
          {submitState.msg}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <a href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
          ← Back to dashboard
        </a>
        <Button type="submit" variant="primary" disabled={isBusy} loading={isBusy}>
          {submitState.kind === "uploading"
            ? "Uploading CV…"
            : submitState.kind === "submitting"
              ? "Submitting…"
              : selectedReq
                ? `Submit for ${selectedReq.title}`
                : "Submit candidate"}
        </Button>
      </div>
    </form>
  );
}

function OutcomeCard({
  result,
  onAnother,
}: {
  result: PartnerSubmitCandidateOutput;
  onAnother: () => void;
}) {
  if (result.outcome === "created") {
    return (
      <Shell tone="success" heading="Submitted successfully">
        <p className="text-sm text-neutral-700">
          The candidate is now in Kyndryl&rsquo;s pipeline and will be screened, scored, and triaged
          like any direct applicant. Your ownership window runs to{" "}
          <strong>{fmtDate(result.claimExpiresAt)}</strong>.
        </p>
        {result.parseStatus === "parse_failed" && (
          <p className="text-sm text-status-warning-700">
            We couldn&rsquo;t automatically read the CV — the recruiter will review it manually.
          </p>
        )}
        <Actions onAnother={onAnother} />
      </Shell>
    );
  }
  if (result.outcome === "duplicate_blocked") {
    return (
      <Shell tone="warning" heading="Candidate already in our pipeline">
        <p className="text-sm text-neutral-700">
          This candidate is already in our pipeline (submitted {result.blockedDaysAgo}{" "}
          {result.blockedDaysAgo === 1 ? "day" : "days"} ago). Per our partner agreement, ownership
          belongs to the first valid submission. You may not submit them for this req. Contact
          partner-support if you believe this is in error.
        </p>
        <Actions onAnother={onAnother} />
      </Shell>
    );
  }
  // added_to_existing
  return (
    <Shell
      tone="info"
      heading={result.alreadyOnThisReq ? "Already submitted" : "Added to this req"}
    >
      {result.alreadyOnThisReq ? (
        <p className="text-sm text-neutral-700">
          You already submitted this candidate for this req on{" "}
          <strong>{fmtDate(result.priorClaimedAt)}</strong>. Track their status on your dashboard.
        </p>
      ) : (
        <p className="text-sm text-neutral-700">
          You already own this candidate from{" "}
          <strong>{result.priorRequisitionTitle ?? "another req"}</strong> (claimed{" "}
          {fmtDate(result.priorClaimedAt)}). Your existing ownership window covers this submission
          too — they&rsquo;ve now been added to this req as well.
        </p>
      )}
      <Actions onAnother={onAnother} />
    </Shell>
  );
}

function Shell({
  tone,
  heading,
  children,
}: {
  tone: "success" | "warning" | "info";
  heading: string;
  children: React.ReactNode;
}) {
  const badgeTone = tone === "success" ? "success" : tone === "warning" ? "warning" : "info";
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge tone={badgeTone}>
          {tone === "success" ? "Accepted" : tone === "warning" ? "Blocked" : "Existing claim"}
        </Badge>
        <h2 className="text-base font-semibold text-neutral-900">{heading}</h2>
      </div>
      {children}
    </Card>
  );
}

function Actions({ onAnother }: { onAnother: () => void }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button type="button" variant="primary" onClick={onAnother}>
        Submit another
      </Button>
      <a href="/" className="text-sm text-neutral-500 hover:text-neutral-800">
        Back to dashboard
      </a>
    </div>
  );
}
