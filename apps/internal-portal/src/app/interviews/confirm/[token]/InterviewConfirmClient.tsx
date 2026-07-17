"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@hireops/ui";
import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";

/**
 * Single-page candidate interview-confirm flow (INT-02).
 *
 * Flow:
 *   1. GET /api/interviews/confirm/:token → render the round summary card.
 *   2. Candidate clicks "Confirm attendance".
 *   3. POST /api/interviews/confirm/:token → ok=true → "Confirmed" screen.
 *
 * Mirrors the offer accept page (state machine, error banners, mobile-first
 * CandidateShell). No name match — the interview confirm is a lighter action
 * than an offer acceptance.
 */

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
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; interview: InterviewPreview }
  | { kind: "confirmed" };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function InterviewConfirmClient({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_BASE}/api/interviews/confirm/${token}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (!body.ok) {
          setState({ kind: "error", reason: friendlyReason(body.reason) });
        } else if (body.alreadyConfirmedAt) {
          setState({ kind: "confirmed" });
        } else {
          setState({ kind: "ready", interview: body as InterviewPreview });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", reason: "Couldn't load your interview." });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submitConfirm() {
    setBusy(true);
    setError(null);
    const res = await fetch(`${API_BASE}/api/interviews/confirm/${token}`, { method: "POST" });
    const body = (await res.json()) as { ok?: boolean; reason?: string };
    setBusy(false);
    if (body.ok) {
      setState({ kind: "confirmed" });
    } else if (body.reason === "already_confirmed") {
      setState({ kind: "confirmed" });
    } else {
      setError(friendlyReason(body.reason ?? "unknown_error"));
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
    return (
      <StatusScreen>
        <EmptyState
          title="Attendance confirmed"
          hint="Thanks — we've let your recruiter know. You'll receive any joining details separately."
        />
      </StatusScreen>
    );
  }

  const iv = state.interview;
  const isTerminal = iv.status !== "scheduled";

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
        <Card className="flex flex-col gap-4 border-brand-200 bg-brand-50/40">
          <p className="text-sm text-neutral-700">
            Clicking <strong>Confirm attendance</strong> tells {iv.companyName} you&rsquo;ll attend
            this interview. If the timing doesn&rsquo;t work, reply to your recruiter to reschedule.
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
            onClick={() => void submitConfirm()}
          >
            Confirm attendance
          </Button>
        </Card>
      )}
    </CandidateShell>
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
