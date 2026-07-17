"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@hireops/ui";
import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { TRPCClientError } from "@trpc/client";
import type { CandidateInterviewRow, CandidateDocumentSlot } from "@hireops/api-types";

/**
 * Candidate dashboard — applications (stage stepper), interviews (confirm),
 * the in-portal offer (view + accept), and the onboarding document checklist
 * (upload + status). Reads are person-scoped by the API; a non-candidate
 * identity gets a calm notice.
 */

/**
 * REST API origin for the multipart document upload (CAND-02) — the tRPC
 * surface runs in-process on the portal, but multipart bodies go straight to
 * apps/api. Same resolution as the recruiter onboarding view.
 */
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/trpc$/, "") ??
  "http://localhost:3001";

const DOC_ACCEPT = ".pdf,.docx,image/jpeg,image/png,application/pdf";

/** Attach the candidate's Supabase session as a bearer token for a REST call. */
async function candidateAuthHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/** Integer paise → a readable ₹ amount (whole rupees; INR-only Wave 1). */
function formatInr(paise: number): string {
  const rupees = Math.round(paise / 100);
  return `₹${rupees.toLocaleString("en-IN")}`;
}

const STAGE_LABELS: Record<string, string> = {
  application_received: "Applied",
  ai_screening: "Screening",
  recruiter_review: "Under review",
  shortlisted: "Shortlisted",
  tech_interview: "Tech interview",
  hr_round: "HR round",
  offer_drafted: "Offer prepared",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  withdrawn: "Withdrawn",
  recruiter_rejected: "Not progressing",
};

const TERMINAL_NEGATIVE = new Set(["offer_declined", "withdrawn", "recruiter_rejected"]);

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function CandidateDashboardClient() {
  const router = useRouter();
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });

  if (me.isLoading) {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState title="Loading your dashboard…" />
        </Card>
      </CandidateShell>
    );
  }

  if (me.isError) {
    const forbidden = me.error instanceof TRPCClientError && me.error.data?.code === "FORBIDDEN";
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState
            title={forbidden ? "This isn't a candidate account" : "We couldn't load your dashboard"}
            hint={
              forbidden
                ? "You're signed in, but not as a candidate. If you applied for a role, activate your candidate account from the sign-in page."
                : "Please try again in a moment."
            }
            action={
              <Button variant="secondary" onClick={() => void signOut(router)}>
                Sign out
              </Button>
            }
          />
        </Card>
      </CandidateShell>
    );
  }

  const person = me.data;
  if (!person) {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState title="Loading your dashboard…" />
        </Card>
      </CandidateShell>
    );
  }

  return (
    <CandidateShell
      brand={person.tenantDisplayName}
      width="2xl"
      footer={
        <button
          type="button"
          className="text-xs font-medium text-neutral-500 underline"
          onClick={() => void signOut(router)}
        >
          Sign out
        </button>
      }
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Hi {person.fullName.split(" ")[0]}
        </h1>
        <p className="text-sm text-neutral-600">
          Your applications and interviews with {person.tenantDisplayName}.
        </p>
      </header>

      <MyOfferSection />
      <ApplicationsSection />
      <InterviewsSection />
      <MyDocumentsSection />
    </CandidateShell>
  );
}

function MyOfferSection() {
  const utils = trpc.useUtils();
  const offerQuery = trpc.candidateGetMyOffer.useQuery();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = trpc.candidateAcceptOffer.useMutation({
    onSuccess: () => {
      setConfirming(false);
      void utils.candidateGetMyOffer.invalidate();
      void utils.candidateGetMyOnboarding.invalidate();
      void utils.candidateListMyApplications.invalidate();
    },
    onError: (e) =>
      setError(
        e instanceof TRPCClientError && e.data?.code === "CONFLICT"
          ? "This offer has already been resolved."
          : "Couldn't accept just now. Please try again.",
      ),
  });

  // Nothing to show until there's an offer.
  if (offerQuery.isLoading || !offerQuery.data || offerQuery.data.offer === null) {
    return null;
  }
  const offer = offerQuery.data.offer;
  const accepted = offer.status === "accepted";

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Your offer</h2>
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-base font-semibold text-neutral-900">{offer.positionTitle}</p>
            <p className="text-sm text-neutral-500">{offer.companyName}</p>
          </div>
          {accepted ? (
            <Badge tone="success">Accepted</Badge>
          ) : (
            <Badge tone="accent">Offer extended</Badge>
          )}
        </div>

        <dl className="flex flex-col gap-1 text-sm">
          <Row label="Base salary" value={`${formatInr(offer.baseSalaryInrPaise)} / year`} />
          {offer.variableTargetInrPaise !== null ? (
            <Row
              label="Variable target"
              value={`${formatInr(offer.variableTargetInrPaise)} / year`}
            />
          ) : null}
          {offer.joiningBonusInrPaise !== null ? (
            <Row label="Joining bonus" value={formatInr(offer.joiningBonusInrPaise)} />
          ) : null}
          <Row label="Joining date" value={offer.joiningDate} />
          <Row label="Location" value={offer.location} />
          {!accepted ? (
            <Row label="Respond by" value={offer.expiryAt.slice(0, 10)} />
          ) : (
            <Row label="Start date" value={offer.joiningDate} />
          )}
        </dl>

        {offer.termsHtml ? (
          <p className="whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-sm text-neutral-600">
            {offer.termsHtml}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-status-error-700">
            {error}
          </p>
        ) : null}

        {accepted ? (
          <p className="text-sm text-status-success-700">
            You accepted this offer. We&rsquo;ll be in touch about onboarding — any documents to
            share appear below.
          </p>
        ) : confirming ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-neutral-700">
              Accept this offer to join {offer.companyName} on {offer.joiningDate}?
            </p>
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={accept.isPending}
                loading={accept.isPending}
                onClick={() => {
                  setError(null);
                  accept.mutate({ offerId: offer.offerId });
                }}
              >
                Confirm acceptance
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={accept.isPending}
                onClick={() => setConfirming(false)}
              >
                Not yet
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
              Accept offer
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

function MyDocumentsSection() {
  const onboarding = trpc.candidateGetMyOnboarding.useQuery();

  // Quiet empty state before an onboarding case exists (pre-offer-accept).
  if (onboarding.isLoading || !onboarding.data || onboarding.data.case === null) {
    return null;
  }
  const caseId = onboarding.data.case.id;
  const { documents } = onboarding.data;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Your documents
      </h2>
      {documents.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            title="Nothing to upload yet"
            hint="When there's a document to collect, it'll show up here with an upload button."
          />
        </Card>
      ) : (
        <Card className="flex flex-col divide-y divide-neutral-100 p-0">
          {documents.map((slot) => (
            <DocumentSlot key={slot.documentTypeId} caseId={caseId} slot={slot} />
          ))}
        </Card>
      )}
    </section>
  );
}

function docStatusBadge(status: string) {
  if (status === "verified") return <Badge tone="success">Verified</Badge>;
  if (status === "rejected") return <Badge tone="warning">Needs re-upload</Badge>;
  return <Badge tone="accent">Pending review</Badge>;
}

function DocumentSlot({ caseId, slot }: { caseId: string; slot: CandidateDocumentSlot }) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = trpc.candidateAttachDocument.useMutation({
    onSuccess: () => void utils.candidateGetMyOnboarding.invalidate(),
    onError: (e) => setError(e.message),
  });
  const doc = slot.document;
  const rejected = doc?.verificationStatus === "rejected";
  const working = busy || attach.isPending;

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/api/candidate-documents/upload`, {
        method: "POST",
        headers: await candidateAuthHeaders(),
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      const json = (await res.json()) as {
        storageKey: string;
        sizeBytes: number;
        contentType: string;
      };
      await attach.mutateAsync({
        caseId,
        documentTypeId: slot.documentTypeId,
        storageKey: json.storageKey,
        fileName: file.name,
        mimeType: json.contentType,
        sizeBytes: json.sizeBytes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-900">
            {slot.documentTypeName ?? "Document"}
          </p>
          {doc ? (
            <p className="mt-0.5 truncate text-xs text-neutral-500">
              {doc.fileName ?? "Uploaded"}
              {doc.uploadedAt ? (
                <span className="text-neutral-400"> · uploaded {doc.uploadedAt.slice(0, 10)}</span>
              ) : null}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-neutral-400">Not uploaded yet</p>
          )}
        </div>
        {doc ? docStatusBadge(doc.verificationStatus) : null}
      </div>

      {rejected && doc?.rejectionReason ? (
        <p className="text-xs text-status-error-700">Reason: {doc.rejectionReason}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-status-error-700">
          {error}
        </p>
      ) : null}

      {doc && doc.verificationStatus === "verified" ? null : (
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50">
          <input
            type="file"
            accept={DOC_ACCEPT}
            className="hidden"
            onChange={onPickFile}
            disabled={working}
          />
          {working ? "Uploading…" : doc ? "Replace file" : "Upload file"}
        </label>
      )}
    </div>
  );
}

function ApplicationsSection() {
  const apps = trpc.candidateListMyApplications.useQuery();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Applications
      </h2>
      {apps.isLoading ? (
        <Card className="p-5">
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : !apps.data || apps.data.items.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            title="No applications yet"
            hint="When you apply for a role, its progress shows up here."
          />
        </Card>
      ) : (
        apps.data.items.map((a) => (
          <Card key={a.applicationId} className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-base font-semibold text-neutral-900">{a.positionTitle}</p>
                {a.location ? <p className="text-sm text-neutral-500">{a.location}</p> : null}
              </div>
              <StageBadge stage={a.currentStage} />
            </div>
            <StageStepper steps={a.stageSteps} current={a.currentStage} />
          </Card>
        ))
      )}
    </section>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const label = STAGE_LABELS[stage] ?? stage;
  if (stage === "offer_accepted") return <Badge tone="success">{label}</Badge>;
  if (TERMINAL_NEGATIVE.has(stage)) return <Badge tone="neutral">{label}</Badge>;
  return <Badge tone="accent">{label}</Badge>;
}

/**
 * Horizontal stepper over the candidate-visible stage vocabulary. The current
 * stage (if it's one of the steps) marks how far along the row is; a terminal
 * negative stage renders the steps muted with a status note instead.
 */
function StageStepper({ steps, current }: { steps: string[]; current: string }) {
  const currentIdx = steps.indexOf(current);
  const isNegativeTerminal = TERMINAL_NEGATIVE.has(current);

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex items-center gap-1.5" aria-label="Application progress">
        {steps.map((s, i) => {
          const reached = !isNegativeTerminal && currentIdx >= 0 && i <= currentIdx;
          const isCurrent = !isNegativeTerminal && i === currentIdx;
          return (
            <li key={s} className="flex flex-1 items-center gap-1.5" title={STAGE_LABELS[s] ?? s}>
              <span
                className={[
                  "h-2 flex-1 rounded-full transition-colors",
                  reached ? "bg-brand-500" : "bg-neutral-200",
                  isCurrent ? "ring-2 ring-brand-200" : "",
                ].join(" ")}
              />
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-neutral-500">
        {isNegativeTerminal
          ? `Status: ${STAGE_LABELS[current] ?? current}`
          : currentIdx >= 0
            ? `Now: ${STAGE_LABELS[current] ?? current}`
            : `Status: ${STAGE_LABELS[current] ?? current}`}
      </p>
    </div>
  );
}

function InterviewsSection() {
  const interviews = trpc.candidateListMyInterviews.useQuery();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Interviews</h2>
      {interviews.isLoading ? (
        <Card className="p-5">
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : !interviews.data || interviews.data.items.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            title="No interviews scheduled"
            hint="When a round is scheduled, you'll see it here and can confirm your attendance."
          />
        </Card>
      ) : (
        interviews.data.items.map((iv) => <InterviewRow key={iv.interviewId} interview={iv} />)
      )}
    </section>
  );
}

function InterviewRow({ interview }: { interview: CandidateInterviewRow }) {
  const utils = trpc.useUtils();
  const [localConfirmedAt, setLocalConfirmedAt] = useState<string | null>(interview.confirmedAt);
  const [error, setError] = useState<string | null>(null);
  const confirm = trpc.candidateConfirmInterview.useMutation({
    onSuccess: (res) => {
      setLocalConfirmedAt(res.confirmedAt);
      void utils.candidateListMyInterviews.invalidate();
    },
    onError: () => setError("Couldn't confirm just now. Please try again."),
  });

  const confirmed = localConfirmedAt !== null;
  const canConfirm = interview.status === "scheduled" && !confirmed;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-neutral-900">{interview.roundName}</p>
          <p className="text-sm text-neutral-500">{interview.positionTitle}</p>
        </div>
        {confirmed ? (
          <Badge tone="success">Confirmed</Badge>
        ) : interview.status !== "scheduled" ? (
          <Badge tone="neutral">{interview.status}</Badge>
        ) : (
          <Badge tone="warning">Awaiting confirmation</Badge>
        )}
      </div>
      <dl className="flex flex-col gap-1 text-sm">
        <Row label="When" value={formatWhen(interview.scheduledStart)} />
        <Row
          label="Format"
          value={`${MODE_LABEL[interview.mode] ?? interview.mode} · ${interview.durationMinutes} min`}
        />
        {interview.meetingUrl ? <Row label="Meeting link" value={interview.meetingUrl} /> : null}
      </dl>
      {error ? (
        <p role="alert" className="text-sm text-status-error-700">
          {error}
        </p>
      ) : null}
      {canConfirm ? (
        <Button
          variant="primary"
          size="sm"
          disabled={confirm.isPending}
          loading={confirm.isPending}
          onClick={() => {
            setError(null);
            confirm.mutate({ interviewId: interview.interviewId });
          }}
        >
          Confirm attendance
        </Button>
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium text-neutral-900 break-all">{value}</dd>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "To be confirmed";
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

async function signOut(router: ReturnType<typeof useRouter>): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  await supabase.auth.signOut();
  router.replace("/candidate/login");
  router.refresh();
}
