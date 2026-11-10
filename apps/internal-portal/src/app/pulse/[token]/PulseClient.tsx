"use client";

import { useEffect, useState } from "react";
import { Button, Card, EmptyState, cn } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";

/**
 * PC-14 — the one-question check-in: "Are you still on track to join on
 * <date>?" Yes / Unsure / No, an optional comment, and an optional 1–5 "how
 * are you feeling about joining". One answer per check-in.
 *
 * Copy is deliberately low-pressure: an "Unsure" or "No" is useful
 * information for the recruiter, never a mark against the candidate, and the
 * page says so.
 */

interface PulseView {
  candidateFirstName: string;
  companyName: string;
  positionTitle: string;
  joiningDateFormatted: string;
  alreadyAnswered: boolean;
  open: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: PulseView }
  | { kind: "done"; view: PulseView };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const ANSWERS = [
  { value: "yes", label: "Yes, on track" },
  { value: "unsure", label: "Not sure" },
  { value: "no", label: "No" },
] as const;
type Answer = (typeof ANSWERS)[number]["value"];

const FEELINGS = [1, 2, 3, 4, 5] as const;

function friendly(reason: string | undefined): string {
  switch (reason) {
    case "expired":
      return "This check-in link has expired.";
    case "already_answered":
      return "You've already answered this check-in — thank you.";
    case "closed":
      return "This check-in is closed.";
    case "not_found":
    case "bad_signature":
    case "malformed":
    case "wrong_action":
      return "This link isn't valid. Please use the button in your most recent email.";
    default:
      return "Something went wrong. Please try again in a moment.";
  }
}

export function PulseClient({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [feeling, setFeeling] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_BASE}/api/pre-joining/pulse/${token}`)
      .then((r) => r.json())
      .then((body: { ok?: boolean; reason?: string } & Partial<PulseView>) => {
        if (cancelled) return;
        if (!body.ok) setState({ kind: "error", message: friendly(body.reason) });
        else setState({ kind: "ready", view: body as PulseView });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", message: friendly(undefined) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(view: PulseView) {
    if (!answer) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pre-joining/pulse/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          onTrack: answer,
          feeling,
          comment: comment.trim() ? comment.trim() : null,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; reason?: string };
      if (body.ok) setState({ kind: "done", view });
      else setError(friendly(body.reason));
    } catch {
      setError(friendly(undefined));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState title="Loading your check-in…" />
        </Card>
      </CandidateShell>
    );
  }
  if (state.kind === "error") {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState title="We couldn't open this check-in" hint={state.message} />
        </Card>
      </CandidateShell>
    );
  }
  const view = state.view;
  if (state.kind === "done" || view.alreadyAnswered || !view.open) {
    return (
      <CandidateShell brand={view.companyName}>
        <Card className="my-auto">
          <EmptyState
            title={
              state.kind === "done" || view.alreadyAnswered
                ? "Thank you"
                : "This check-in is closed"
            }
            hint={
              state.kind === "done" || view.alreadyAnswered
                ? "Your answer has been shared with your recruiter. If anything changes, just reply to any of our emails."
                : "If you have a question, reply to any of our emails and it will reach your recruiter."
            }
          />
        </Card>
      </CandidateShell>
    );
  }

  return (
    <CandidateShell brand={view.companyName}>
      <header className="flex flex-col items-center gap-2 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {view.positionTitle}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          {view.candidateFirstName ? `Hi ${view.candidateFirstName}` : "Quick check-in"}
        </h1>
      </header>

      <Card className="space-y-6">
        <fieldset className="space-y-3">
          <legend className="text-base font-semibold text-neutral-900">
            Are you still on track to join on {view.joiningDateFormatted}?
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {ANSWERS.map((a) => (
              <button
                key={a.value}
                type="button"
                onClick={() => setAnswer(a.value)}
                aria-pressed={answer === a.value}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-sm font-medium transition-colors",
                  answer === a.value
                    ? "border-brand-600 bg-brand-50 text-brand-800"
                    : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-neutral-500">
            An honest answer helps us help you — if something has changed, your recruiter can often
            sort it out early.
          </p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-neutral-800">
            How are you feeling about joining? <span className="text-neutral-400">(optional)</span>
          </legend>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Not great</span>
            {FEELINGS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setFeeling(feeling === n ? null : n)}
                aria-pressed={feeling === n}
                aria-label={`${n} of 5`}
                className={cn(
                  "h-9 w-9 rounded-full border text-sm font-medium",
                  feeling === n
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300",
                )}
              >
                {n}
              </button>
            ))}
            <span className="text-xs text-neutral-500">Great</span>
          </div>
        </fieldset>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-neutral-800">
            Anything you'd like your recruiter to know?{" "}
            <span className="text-neutral-400">(optional)</span>
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 1000))}
            rows={3}
            className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </label>

        {error ? <p className="text-sm text-status-error-700">{error}</p> : null}

        <Button className="w-full" disabled={!answer || busy} onClick={() => void submit(view)}>
          {busy ? "Sending…" : "Send"}
        </Button>
        <p className="text-center text-xs text-neutral-500">
          Your answer goes to your recruiter at {view.companyName}.
        </p>
      </Card>
    </CandidateShell>
  );
}
