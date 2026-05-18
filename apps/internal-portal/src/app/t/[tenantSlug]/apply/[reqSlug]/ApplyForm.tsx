"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button, Input } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Candidate apply form (CRS-01). Mobile-first single column. Uses
 * useState + zod (the established portal pattern from LoginForm)
 * rather than react-hook-form to keep the dep surface flat.
 *
 * Flow:
 *   1. Fill fields + pick a resume.
 *   2. Submit POSTs the resume to /api/upload/resume (public endpoint),
 *      then calls submitApplication via the unauthenticated tRPC link.
 *   3. On success, route to ./submitted?ref=<8-char-ref>.
 *
 * Validation is shared with the server-side zod schema by mirroring
 * field shapes; the server is authoritative (zodError surfaces inline
 * via the per-field errors map).
 *
 * Out of scope here (noted in the CRS-01 ticket):
 *   - CAPTCHA / rate limit / abuse defences (POC traffic).
 *   - Phone format strict validation beyond the server's normalisation.
 *   - "How did you hear" → mapping to applications.source enum (best-
 *     effort; verbatim string is also sent so the dedup attempt row
 *     keeps the raw answer).
 */

const APPLY_FORM_CONSENT_VERSION = "v1-2026-05";
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const ALLOWED_RESUME_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * Maps the candidate's "How did you hear about us?" answer to the
 * application source enum. Falls back to career_site. The verbatim
 * answer is also sent separately so the audit row keeps the
 * unmapped detail (e.g. "via my manager Rohit").
 */
function mapSourceText(text: string): "career_site" | "referral" | "job_board" | "whatsapp" {
  const t = text.trim().toLowerCase();
  if (!t) return "career_site";
  if (/\b(linkedin|naukri|indeed|hirist|monster|instahyre|cutshort)\b/.test(t)) return "job_board";
  if (/\b(refer|friend|colleague|employee|via|told)\b/.test(t)) return "referral";
  if (/\bwhatsapp\b/.test(t)) return "whatsapp";
  return "career_site";
}

/**
 * Indian-10-digit OR E.164. Country code auto-prepended (+91) when the
 * user enters a bare 10-digit number. The server re-normalises to
 * digits-only for dedup; this client-side step is for storage shape.
 */
function normalisePhoneForSubmit(raw: string): string {
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed.replace(/[\s-]/g, ""))) {
    return trimmed.replace(/[\s-]/g, "");
  }
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  return trimmed; // let server-side validation reject malformed input
}

const fieldSchema = z.object({
  fullName: z.string().trim().min(1, "Required").max(200),
  email: z.string().trim().email("Enter a valid email"),
  phone: z
    .string()
    .trim()
    .min(8, "Enter a valid phone number")
    .max(40)
    .refine(
      (v) => /^\+?\d[\d\s-]{7,}$/.test(v),
      "Digits only, with or without country code",
    ),
  linkedinUrl: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || /^https?:\/\/.+/i.test(v),
      "Must start with http:// or https://",
    ),
  sourceText: z.string().trim().max(200).optional(),
  resume: z
    .instanceof(File, { message: "Choose your CV" })
    .refine((f) => f.size <= MAX_RESUME_BYTES, "File must be ≤ 5 MB")
    .refine((f) => ALLOWED_RESUME_MIME.has(f.type), "PDF or DOCX only"),
  consentGiven: z.literal(true, { message: "Consent is required to apply" }),
});

type FieldErrors = Partial<Record<keyof z.infer<typeof fieldSchema>, string>>;

interface ApplyFormProps {
  requisitionId: string;
  tenantDisplayName: string;
  positionTitle: string;
  tenantSlug: string;
  reqSlug: string;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/trpc$/, "") ??
  "http://localhost:3001";

export function ApplyForm({
  requisitionId,
  tenantDisplayName,
  positionTitle,
  tenantSlug,
  reqSlug,
}: ApplyFormProps) {
  void positionTitle;
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [resume, setResume] = useState<File | null>(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitState, setSubmitState] = useState<
    { kind: "idle" } | { kind: "uploading" } | { kind: "submitting" } | { kind: "error"; msg: string }
  >({ kind: "idle" });

  // Hydration marker — Playwright (and any other browser test) can wait
  // for [data-hydrated="true"] before interacting. Without this, a click
  // can fire before React attaches the onSubmit handler and the form
  // does a native GET with the field values in the querystring.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const submitMutation = trpc.submitApplication.useMutation();
  const isSubmitting = submitState.kind === "uploading" || submitState.kind === "submitting";

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setResume(f);
    setFieldErrors((p) => ({ ...p, resume: undefined }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});

    const parsed = fieldSchema.safeParse({
      fullName,
      email,
      phone,
      linkedinUrl: linkedinUrl || undefined,
      sourceText: sourceText || undefined,
      resume,
      consentGiven,
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
      const json = (await res.json()) as { storageKey: string };
      storageKey = json.storageKey;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Resume upload failed";
      setSubmitState({ kind: "error", msg });
      return;
    }

    setSubmitState({ kind: "submitting" });
    try {
      const result = await submitMutation.mutateAsync({
        requisitionId,
        resumeUploadKey: storageKey,
        applicant: {
          fullName: parsed.data.fullName,
          email: parsed.data.email,
          phone: normalisePhoneForSubmit(parsed.data.phone),
          linkedinUrl: parsed.data.linkedinUrl,
          sourceText: parsed.data.sourceText,
          locationCountry: "IN",
        },
        source: mapSourceText(parsed.data.sourceText ?? ""),
        consentVersion: APPLY_FORM_CONSENT_VERSION,
      });
      const ref = result.applicationId.slice(0, 8);
      router.push(`/t/${tenantSlug}/apply/${reqSlug}/submitted?ref=${ref}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Submission failed";
      setSubmitState({ kind: "error", msg });
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5"
      aria-label="Apply for this role"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <Input
        label="Full name"
        type="text"
        required
        autoComplete="name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        error={fieldErrors.fullName}
      />
      <Input
        label="Email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors.email}
      />
      <Input
        label="Phone"
        type="tel"
        required
        autoComplete="tel"
        hint="10 digits (we&rsquo;ll add +91) or full international format."
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        error={fieldErrors.phone}
      />
      <Input
        label="LinkedIn (optional)"
        type="text"
        autoComplete="url"
        placeholder="https://www.linkedin.com/in/…"
        value={linkedinUrl}
        onChange={(e) => setLinkedinUrl(e.target.value)}
        error={fieldErrors.linkedinUrl}
      />
      <Input
        label="How did you hear about us? (optional)"
        type="text"
        value={sourceText}
        onChange={(e) => setSourceText(e.target.value)}
        error={fieldErrors.sourceText}
      />

      <div className="flex flex-col gap-1">
        <label htmlFor="resume" className="text-sm font-medium text-neutral-700">
          Resume
          <span className="ml-1 text-status-error-500" aria-hidden="true">
            *
          </span>
        </label>
        <input
          id="resume"
          name="resume"
          type="file"
          accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onFileChange}
          aria-invalid={fieldErrors.resume ? true : undefined}
          aria-describedby={fieldErrors.resume ? "resume-error" : "resume-hint"}
          className="block min-h-[44px] w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-neutral-700 hover:file:bg-neutral-200"
        />
        {fieldErrors.resume ? (
          <p id="resume-error" className="text-sm text-status-error-700">
            {fieldErrors.resume}
          </p>
        ) : (
          <p id="resume-hint" className="text-sm text-neutral-500">
            PDF or DOCX, up to 5 MB.
          </p>
        )}
      </div>

      {/*
       * Native checkbox + inline label so the privacy-policy link can
       * render in the consent copy. The @hireops/ui Checkbox accepts
       * string-only labels and onCheckedChange — both wrong for this
       * shape. Mobile target is the full row (44+ px), not just the box.
       */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="consent"
          className="flex min-h-[44px] items-start gap-3 text-sm text-neutral-700"
        >
          <input
            id="consent"
            name="consent"
            type="checkbox"
            checked={consentGiven}
            onChange={(e) => setConsentGiven(e.target.checked)}
            aria-invalid={fieldErrors.consentGiven ? true : undefined}
            aria-describedby={fieldErrors.consentGiven ? "consent-error" : undefined}
            className="mt-1 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          />
          <span>
            I consent to <strong>{tenantDisplayName}</strong> processing my personal data for
            recruitment purposes. See our{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 underline"
            >
              privacy policy
            </a>
            .
          </span>
        </label>
        {fieldErrors.consentGiven && (
          <p id="consent-error" className="ml-8 text-sm text-status-error-700">
            {fieldErrors.consentGiven}
          </p>
        )}
      </div>

      {submitState.kind === "error" && (
        <p role="alert" className="text-sm text-status-error-700">
          {submitState.msg}
        </p>
      )}

      {/*
       * brand-500 (the Button primary default) is 3.67:1 against white,
       * below the WCAG-AA 4.5:1 threshold axe enforces for normal-weight
       * text. Bump to brand-600 (5.2:1) + brand-700 hover so the
       * candidate-facing submit clears axe color-contrast. Fixing the
       * variant default is a wider design-system change tracked
       * separately in open-questions.md.
       */}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={isSubmitting}
        loading={isSubmitting}
        className="bg-brand-600 hover:bg-brand-700 active:bg-brand-700"
      >
        {submitState.kind === "uploading"
          ? "Uploading resume…"
          : submitState.kind === "submitting"
            ? "Submitting…"
            : "Submit application"}
      </Button>
    </form>
  );
}
