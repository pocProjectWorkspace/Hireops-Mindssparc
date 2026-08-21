"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@hireops/ui";
import { Badge, Card, EmptyState, cn } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import {
  confirmRequestInit,
  consentChangeRequestInit,
  type ConsentChange,
  type ConsentChoice,
} from "./recording-consent-request";

/**
 * Single-page candidate interview-confirm flow (INT-02), plus the recording
 * consent capture and withdrawal controls (N2b).
 *
 * Flow:
 *   1. GET /api/interviews/confirm/:token → round summary + this round's
 *      recording state (the recruiter's ask, the candidate's effective
 *      consent, and the disclosure copy + version to render it under).
 *   2. Candidate optionally answers the recording question, then clicks
 *      "Confirm attendance".
 *   3. POST /api/interviews/confirm/:token → ok=true → "Confirmed" screen,
 *      which keeps the consent control on screen so the decision stays
 *      changeable (the GET deliberately does not consume the link, so this
 *      page is still reachable on every later visit).
 *
 * Four things in the recording block are compliance, not styling:
 *   • NOTHING IS PRE-SELECTED, and the two answers render identically. A
 *     pre-ticked default would make every stored consent row worthless.
 *   • AN UNANSWERED QUESTION SENDS NO FIELD AT ALL, and confirming is never
 *     gated on answering. The API writes no consent row for an absent
 *     `recordingConsent` — silence is not consent — and attending is the
 *     point of this page; recording is optional to it. That rule lives in
 *     ./recording-consent-request, which is where it can be tested.
 *   • THE WORDING IS SERVED, NEVER TYPED HERE. `recordingConsentDisclosure`
 *     arrives with the version the POST stamps onto the consent row, so the
 *     two cannot drift. (That copy is flagged as awaiting legal review; it is
 *     rendered as served, which is the point of serving it.)
 *   • THE DISPLAYED STATE IS ALWAYS THE SERVER'S. Every call re-reads the
 *     consent the API returns rather than assuming its own write landed — the
 *     confirm route swallows a consent-write failure on purpose so it cannot
 *     cost the candidate their confirmation, so an optimistic UI here could
 *     tell someone they had withdrawn when the log says they had not.
 *
 * Mirrors the offer accept page (state machine, error banners, mobile-first
 * CandidateShell). No name match — the interview confirm is a lighter action
 * than an offer acceptance.
 */

/** Mirror of the API's EffectiveRecordingConsent. `decision: null` = never asked. */
interface RecordingConsent {
  decision: "granted" | "declined" | "withdrawn" | null;
  decidedAt: string | null;
  consentVersion: string | null;
  capturedVia: string | null;
  permitted: boolean;
}

/** The served disclosure: copy + the version it is stamped under. */
interface RecordingDisclosure {
  version: string;
  title: string;
  body: string[];
  grantLabel: string;
  declineLabel: string;
  withdrawLabel: string;
}

interface InterviewPreview {
  interviewId: string;
  status: string;
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  scheduledStart: string | null;
  durationMinutes: number;
  mode: string;
  meetingUrl: string | null;
  alreadyConfirmedAt: string | null;
  // N2a recording fields — optional so a pre-N2a API response still parses
  // (and so an older deploy degrades to "no recording block", not a crash).
  recordingRequested?: boolean;
  recordingConsent?: RecordingConsent | null;
  recordingConsentDisclosure?: RecordingDisclosure | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; interview: InterviewPreview }
  // Carries the interview so the confirmed screen can still show — and change
  // — the recording decision.
  | { kind: "confirmed"; interview: InterviewPreview };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

interface ConsentResponse {
  ok?: boolean;
  reason?: string;
  recordingConsent?: RecordingConsent | null;
}

export function InterviewConfirmClient({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The recording legs are tracked separately from the confirmation: a
  // consent failure must not read as a failed confirmation, and vice versa.
  const [choice, setChoice] = useState<ConsentChoice>(null);
  const [consent, setConsent] = useState<RecordingConsent | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentNotice, setConsentNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_BASE}/api/interviews/confirm/${token}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (!body.ok) {
          setState({ kind: "error", reason: friendlyReason(body.reason) });
          return;
        }
        const interview = body as InterviewPreview;
        setConsent(interview.recordingConsent ?? null);
        setState(
          interview.alreadyConfirmedAt
            ? { kind: "confirmed", interview }
            : { kind: "ready", interview },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", reason: "Couldn't load your interview." });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submitConfirm(interview: InterviewPreview) {
    const recordingRequested = interview.recordingRequested === true;
    const answered = recordingRequested && choice !== null;
    setBusy(true);
    setError(null);
    setConsentError(null);
    setConsentNotice(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/interviews/confirm/${token}`,
        confirmRequestInit({ recordingRequested, choice }),
      );
      const body = (await res.json()) as ConsentResponse;
      if (body.ok || body.reason === "already_confirmed") {
        // The confirmation is the primary action and has landed. The consent
        // leg is reported separately BECAUSE the route swallows its own write
        // failure to protect that confirmation — so a returned decision that
        // isn't the one just sent means the answer did not stick, and the
        // candidate is told to set it below rather than shown a state the
        // consent log does not hold.
        if (body.ok && answered) {
          const returned = body.recordingConsent ?? null;
          setConsent(returned);
          if (returned?.decision !== choice) {
            setConsentNotice(
              "We couldn't save your answer about recording, so nothing has been recorded. " +
                "Please set your choice below.",
            );
          }
        }
        setState({ kind: "confirmed", interview });
      } else {
        setError(friendlyReason(body.reason ?? "unknown_error"));
      }
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Grant or withdraw after confirmation. Not single-use; safe to repeat. */
  async function changeConsent(decision: ConsentChange) {
    setConsentBusy(true);
    setConsentError(null);
    setConsentNotice(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/interviews/confirm/${token}/recording-consent`,
        consentChangeRequestInit(decision),
      );
      const body = (await res.json()) as ConsentResponse;
      if (body.ok && body.recordingConsent) {
        setConsent(body.recordingConsent);
      } else {
        // Nothing is assumed on failure: the displayed state stays exactly
        // what the server last told us, and the candidate is told plainly
        // that their change did not happen.
        setConsentError(
          `${friendlyReason(body.reason ?? "unknown_error")} Your recording choice is unchanged.`,
        );
      }
    } catch {
      setConsentError("We couldn't reach the server, so nothing changed. Please try again.");
    } finally {
      setConsentBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <StatusScreen>
        <EmptyState title="Loading your interview…" />
      </StatusScreen>
    );
  }
  if (state.kind === "error") {
    return (
      <StatusScreen>
        <EmptyState title="We hit a snag" hint={state.reason} />
      </StatusScreen>
    );
  }
  if (state.kind === "confirmed") {
    const confirmedInterview = state.interview;
    const confirmedDisclosure = confirmedInterview.recordingConsentDisclosure;
    // A round nobody asked to record shows nothing about recording at all —
    // the unchanged confirmation screen.
    if (confirmedInterview.recordingRequested !== true || !confirmedDisclosure) {
      return (
        <StatusScreen>
          <EmptyState
            title="Attendance confirmed"
            hint="Thanks, we've let your recruiter know. You'll receive any joining details separately."
          />
        </StatusScreen>
      );
    }
    return (
      <CandidateShell brand={confirmedInterview.companyName}>
        <Card>
          <EmptyState
            title="Attendance confirmed"
            hint="Thanks, we've let your recruiter know. You'll receive any joining details separately."
          />
        </Card>
        <RecordingConsentPanel
          disclosure={confirmedDisclosure}
          consent={consent}
          busy={consentBusy}
          error={consentError}
          notice={consentNotice}
          onChange={(decision) => void changeConsent(decision)}
        />
      </CandidateShell>
    );
  }

  const iv = state.interview;
  const isTerminal = iv.status !== "scheduled";
  const disclosure = iv.recordingConsentDisclosure;
  const askRecording = iv.recordingRequested === true && Boolean(disclosure);

  return (
    <CandidateShell brand={iv.companyName}>
      <header className="flex flex-col items-center gap-2 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {iv.companyName}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Interview Invitation
        </h1>
        <p className="text-sm text-neutral-600">
          Hi {iv.candidateName.split(" ")[0]}, please confirm your attendance below.
        </p>
      </header>

      <Card className="p-0">
        <div className="border-b border-neutral-100 px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Round</p>
          <p className="mt-0.5 text-base font-semibold text-neutral-900">{iv.roundName}</p>
          <p className="text-sm text-neutral-600">{iv.positionTitle}</p>
        </div>
        <dl className="px-5 py-1">
          <SummaryRow label="When" value={formatWhen(iv.scheduledStart)} />
          <SummaryRow
            label="Format"
            value={`${MODE_LABEL[iv.mode] ?? iv.mode} · ${iv.durationMinutes} minutes`}
          />
          {iv.meetingUrl ? <SummaryRow label="Meeting link" value={iv.meetingUrl} /> : null}
        </dl>
      </Card>

      {isTerminal ? (
        <Card className="flex flex-col items-center gap-3 py-8 text-center">
          <Badge tone="warning">Status: {iv.status}</Badge>
          <p className="max-w-sm text-sm text-neutral-600">
            This interview is no longer active. Please contact your recruiter if you have questions.
          </p>
        </Card>
      ) : (
        <>
          {askRecording && disclosure ? (
            <RecordingConsentAsk
              disclosure={disclosure}
              choice={choice}
              disabled={busy}
              onChoose={setChoice}
            />
          ) : null}
          <Card className="flex flex-col gap-4 border-brand-200 bg-brand-50/40">
            <p className="text-sm text-neutral-700">
              Clicking <strong>Confirm attendance</strong> tells {iv.companyName} you&rsquo;ll
              attend this interview. If the timing doesn&rsquo;t work, reply to your recruiter to
              reschedule.
            </p>
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800"
              >
                {error}
              </div>
            ) : null}
            <Button
              type="button"
              variant="primary"
              size="lg"
              fullWidth
              disabled={busy}
              loading={busy}
              onClick={() => void submitConfirm(iv)}
            >
              Confirm attendance
            </Button>
          </Card>
        </>
      )}
    </CandidateShell>
  );
}

/**
 * The confirm-time question. A native fieldset/legend/radio group: the legend
 * names the group for assistive tech, and the two options carry IDENTICAL
 * markup, type and weight so neither answer is the easier one to give.
 */
function RecordingConsentAsk({
  disclosure,
  choice,
  disabled,
  onChoose,
}: {
  disclosure: RecordingDisclosure;
  choice: ConsentChoice;
  disabled: boolean;
  onChoose: (choice: ConsentChoice) => void;
}) {
  return (
    <Card>
      <fieldset disabled={disabled}>
        <legend className="text-base font-semibold text-neutral-900">{disclosure.title}</legend>
        <DisclosureBody body={disclosure.body} />
        <div className="mt-4 flex flex-col gap-2">
          <ConsentOption
            value="granted"
            label={disclosure.grantLabel}
            checked={choice === "granted"}
            onChoose={onChoose}
          />
          <ConsentOption
            value="declined"
            label={disclosure.declineLabel}
            checked={choice === "declined"}
            onChoose={onChoose}
          />
        </div>
      </fieldset>
    </Card>
  );
}

/** One answer. No `defaultChecked` anywhere in this file, deliberately. */
function ConsentOption({
  value,
  label,
  checked,
  onChoose,
}: {
  value: Exclude<ConsentChoice, null>;
  label: string;
  checked: boolean;
  onChoose: (choice: ConsentChoice) => void;
}) {
  const id = `recording-consent-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 text-sm text-neutral-800",
        checked ? "border-brand-300 bg-brand-50/60" : "border-neutral-200 bg-white",
      )}
    >
      <input
        id={id}
        type="radio"
        name="recording-consent"
        value={value}
        checked={checked}
        onChange={() => onChoose(value)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * The post-confirmation control: what the consent log actually says right now,
 * and the one move that changes it. Reachable because GET /confirm/:token does
 * not consume the link.
 */
function RecordingConsentPanel({
  disclosure,
  consent,
  busy,
  error,
  notice,
  onChange,
}: {
  disclosure: RecordingDisclosure;
  consent: RecordingConsent | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onChange: (decision: ConsentChange) => void;
}) {
  const decision = consent?.decision ?? null;
  const granted = decision === "granted";
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-neutral-900">{disclosure.title}</h2>
        <Badge tone={granted ? "success" : "neutral"}>{consentBadgeLabel(decision)}</Badge>
      </div>
      <p className="text-sm text-neutral-700">{consentStatusLine(consent)}</p>
      <DisclosureBody body={disclosure.body} />
      {notice ? (
        <div
          role="status"
          className="rounded-md border border-status-warning-200 bg-status-warning-50 px-3.5 py-2.5 text-sm text-status-warning-800"
        >
          {notice}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800"
        >
          {error}
        </div>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="lg"
        fullWidth
        disabled={busy}
        loading={busy}
        onClick={() => onChange(granted ? "withdrawn" : "granted")}
      >
        {granted ? disclosure.withdrawLabel : disclosure.grantLabel}
      </Button>
    </Card>
  );
}

/** The served paragraphs, in order, rendered as served. */
function DisclosureBody({ body }: { body: string[] }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {body.map((paragraph) => (
        <p key={paragraph} className="text-sm leading-relaxed text-neutral-700">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function StatusScreen({ children }: { children: ReactNode }) {
  return (
    <CandidateShell>
      <Card className="my-auto">{children}</Card>
    </CandidateShell>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-neutral-100 py-2.5 last:border-0">
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-right text-sm font-medium text-neutral-900 break-all">{value}</dd>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "To be confirmed";
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

/** Date only, sliced like formatWhen — no Intl, so SSR and client agree. */
function formatDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "an earlier date";
}

function consentBadgeLabel(decision: RecordingConsent["decision"]): string {
  switch (decision) {
    case "granted":
      return "Recording allowed";
    case "declined":
      return "Recording declined";
    case "withdrawn":
      return "Consent withdrawn";
    default:
      return "Not answered";
  }
}

/** The candidate's own state, with the date it was captured. */
function consentStatusLine(consent: RecordingConsent | null): string {
  switch (consent?.decision ?? null) {
    case "granted":
      return `You agreed to this interview being recorded on ${formatDay(consent?.decidedAt ?? null)}.`;
    case "declined":
      return `You declined recording on ${formatDay(consent?.decidedAt ?? null)}.`;
    case "withdrawn":
      return `You withdrew your consent on ${formatDay(consent?.decidedAt ?? null)}.`;
    default:
      return "You haven't answered this yet. Nothing is recorded unless you agree.";
  }
}

function friendlyReason(code: string): string {
  switch (code) {
    case "expired":
      return "This link has expired. Please contact your recruiter.";
    case "bad_signature":
    case "malformed":
      return "This link is invalid. Please contact your recruiter.";
    case "interview_not_found":
      return "We couldn't find this interview. Please contact your recruiter.";
    case "already_confirmed":
      return "You've already confirmed this interview.";
    case "already_cancelled":
      return "This interview has been cancelled. Please contact your recruiter.";
    case "wrong_action":
      return "This link is for a different action. Please contact your recruiter.";
    default:
      return `Something went wrong (${code}). Please try again or contact your recruiter.`;
  }
}
