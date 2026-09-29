"use client";

import { useState } from "react";
import { Button, Select } from "@hireops/ui";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { AiInterviewSessionCard, AiInterviewSessionStatus } from "@hireops/api-types";

/**
 * B1 — the recruiter's AI first-round card for ONE `ai_async` interview.
 *
 * The N4 API already walks generate → approve → issue; this is the only
 * product surface that reaches it. The ladder is deliberately human-gated:
 * the model drafts questions, a person approves them, and only an approved
 * set can be turned into a candidate link.
 *
 * THE LINK IS SHOWN ONCE. `issueAiInterviewSession` returns the raw url on
 * the wire exactly once — only its hash is stored — so it lives in this
 * component's state and nowhere else: not the query cache, not the console.
 * Unmount the card and it is gone; re-issuing is the recovery path.
 */

const STATUS_LABEL: Record<AiInterviewSessionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  issued: "Link issued",
  in_progress: "In progress",
  submitted: "Answers received",
  expired: "Expired",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<AiInterviewSessionStatus, BadgeTone> = {
  draft: "warning",
  approved: "info",
  issued: "info",
  in_progress: "info",
  submitted: "success",
  expired: "neutral",
  cancelled: "error",
};

const EXPIRY_OPTIONS = [
  { value: "3", label: "3 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
];

const RECORDING_HINT =
  "The candidate is answering. Transcript and AI notes appear under Recording once transcription completes.";

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function questionOrder(key: string): number {
  const n = parseInt(key.replace(/^q/, ""), 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

export function AiInterviewRoundSection({ interviewId }: { interviewId: string }) {
  const utils = trpc.useUtils();
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [issued, setIssued] = useState<{ interviewUrl: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const q = trpc.getAiInterviewSession.useQuery({ interviewId });
  const invalidate = () => void utils.getAiInterviewSession.invalidate({ interviewId });

  const generate = trpc.generateAiInterviewQuestions.useMutation({ onSuccess: invalidate });
  const approve = trpc.approveAiInterviewQuestions.useMutation({ onSuccess: invalidate });
  const issue = trpc.issueAiInterviewSession.useMutation({
    onSuccess: (res) => {
      // Component state only — see header.
      setIssued({ interviewUrl: res.interviewUrl, expiresAt: res.expiresAt });
      invalidate();
    },
  });

  if (q.isLoading) {
    return <p className="mt-2 text-xs text-neutral-500">Loading AI round…</p>;
  }
  if (q.error) {
    return <p className="mt-2 text-xs text-status-error-700">{q.error.message}</p>;
  }
  if (!q.data) return null;

  const { session, rubric, questionsEnabled } = q.data;
  const busy = generate.isPending || approve.isPending || issue.isPending;
  const mutationError =
    generate.error?.message ?? approve.error?.message ?? issue.error?.message ?? null;

  async function onCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be refused (permissions, insecure origin); the input is
      // read-only but still selectable, so the recruiter can copy by hand.
    }
  }

  return (
    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50/60 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-neutral-700">AI first round</span>
        {session ? (
          <Badge tone={STATUS_TONE[session.status]}>{STATUS_LABEL[session.status]}</Badge>
        ) : null}
      </div>

      {!questionsEnabled ? (
        <p className="text-neutral-500">
          AI interview questions are switched off for this tenant. An admin can enable them under AI
          settings.
        </p>
      ) : session === null ? (
        <div>
          <p className="mb-2 text-neutral-500">
            No questions generated yet. Questions are grounded in the JD, its skills, the knockouts
            and the round&apos;s scorecard — nothing else.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => generate.mutate({ interviewId })}
          >
            Generate questions
          </Button>
        </div>
      ) : (
        <SessionBody
          session={session}
          rubric={rubric}
          busy={busy}
          generating={generate.isPending}
          approving={approve.isPending}
          issuing={issue.isPending}
          expiresInDays={expiresInDays}
          onExpiresChange={setExpiresInDays}
          onRegenerate={() => generate.mutate({ interviewId })}
          onApprove={() => approve.mutate({ interviewId })}
          onIssue={() => issue.mutate({ interviewId, expiresInDays: parseInt(expiresInDays, 10) })}
        />
      )}

      {generate.isPending ? (
        <p className="mt-2 text-neutral-500">Generating… this takes about ten seconds.</p>
      ) : null}

      {issued ? (
        <div className="mt-3 rounded-md border border-brand-200 bg-brand-50/40 p-3">
          <p className="mb-1 font-semibold text-brand-700">Candidate link</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              readOnly
              value={issued.interviewUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white p-2 text-xs"
            />
            <Button variant="secondary" size="sm" onClick={() => void onCopy(issued.interviewUrl)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-1 text-neutral-500">Expires {fmtWhen(issued.expiresAt)}</p>
          <p className="mt-1 text-neutral-600">
            Shown once. Copy it now and send it to the candidate yourself — the pilot&apos;s email
            is in test mode.
          </p>
        </div>
      ) : null}

      {mutationError ? <p className="mt-2 text-status-error-700">{mutationError}</p> : null}
    </div>
  );
}

function SessionBody({
  session,
  rubric,
  busy,
  generating,
  approving,
  issuing,
  expiresInDays,
  onExpiresChange,
  onRegenerate,
  onApprove,
  onIssue,
}: {
  session: AiInterviewSessionCard;
  rubric: { key: string; label: string }[];
  busy: boolean;
  generating: boolean;
  approving: boolean;
  issuing: boolean;
  expiresInDays: string;
  onExpiresChange: (v: string) => void;
  onRegenerate: () => void;
  onApprove: () => void;
  onIssue: () => void;
}) {
  const { status } = session;
  const answering = status === "issued" || status === "in_progress" || status === "submitted";

  return (
    <div>
      <QuestionList session={session} rubric={rubric} />

      {status === "draft" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={onApprove}>
            {approving ? "Approving…" : "Approve questions"}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRegenerate}>
            {generating ? "Regenerating…" : "Regenerate"}
          </Button>
        </div>
      ) : null}

      {status === "approved" ? (
        <div className="mt-3 space-y-2">
          <p className="text-neutral-500">
            Approved by {session.approvedByName ?? "a team member"} · {fmtWhen(session.approvedAt)}
          </p>
          <div className="max-w-[12rem]">
            <Select
              label="Link valid for"
              size="sm"
              options={EXPIRY_OPTIONS}
              value={expiresInDays}
              onValueChange={onExpiresChange}
              disabled={busy}
            />
          </div>
          <Button variant="primary" size="sm" disabled={busy} onClick={onIssue}>
            {issuing ? "Issuing…" : "Issue candidate link"}
          </Button>
        </div>
      ) : null}

      {answering ? <p className="mt-3 text-neutral-500">{RECORDING_HINT}</p> : null}

      {status === "in_progress" || status === "submitted" ? (
        <IntegrityLine integrity={session.integrity} />
      ) : null}

      {status === "expired" || status === "cancelled" ? (
        <div className="mt-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRegenerate}>
            {generating ? "Regenerating…" : "Regenerate"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const INTEGRITY_TITLE = "Signals for a human reviewer — never used to decide automatically.";

/**
 * AI-INT-1 — the integrity log in one line. Neutral tone on purpose: a tab
 * switch has plenty of innocent explanations, and colouring it as a warning
 * would be the UI making the judgement the product says only a person makes.
 */
function IntegrityLine({ integrity }: { integrity: AiInterviewSessionCard["integrity"] }) {
  const tabSwitches = integrity?.tabSwitches ?? 0;
  const exits = integrity?.fullscreenExits ?? 0;
  const parts: string[] = [];
  if (tabSwitches > 0) parts.push(plural(tabSwitches, "tab switch", "tab switches"));
  if (exits > 0) parts.push(plural(exits, "full-screen exit", "full-screen exits"));
  if (parts.length > 0 && integrity && integrity.totalAwayMs > 0) {
    parts.push(`${fmtDuration(integrity.totalAwayMs)} away`);
  }
  const text =
    parts.length > 0 ? parts.join(" · ") : "no tab switches or full-screen exits recorded";
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-neutral-600"
      title={INTEGRITY_TITLE}
    >
      <Badge tone="neutral">Integrity</Badge>
      <span>{text}</span>
    </div>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** 41s · 3m 05s · 1h 02m — a glance figure, not a timesheet. */
function fmtDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function QuestionList({
  session,
  rubric,
}: {
  session: AiInterviewSessionCard;
  rubric: { key: string; label: string }[];
}) {
  // The session carries its own rubric snapshot; the query's top-level rubric
  // is the fallback for any key the session's copy does not name.
  const labels = new Map<string, string>();
  for (const r of rubric) labels.set(r.key, r.label);
  for (const r of session.rubric) labels.set(r.key, r.label);

  const ordered = [...session.questions].sort(
    (a, b) => questionOrder(a.key) - questionOrder(b.key),
  );

  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        Machine-generated — approve before anything is sent.
      </p>
      <ol className="space-y-2">
        {ordered.map((question) => (
          <li
            key={question.key}
            className="flex gap-2 rounded-md border border-neutral-200 bg-white p-2"
          >
            <span className="shrink-0 font-semibold tabular-nums text-neutral-700">
              {question.key.toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="text-neutral-800">{question.prompt}</p>
              <span className="mt-1 inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                {labels.get(question.rubricKey) ?? question.rubricKey}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {session.model || session.promptVersion ? (
        <p className="mt-2 text-[11px] text-neutral-400">
          Generated by {session.model ?? "unknown model"}
          {session.promptVersion ? ` · prompt ${session.promptVersion}` : ""}
        </p>
      ) : null}
    </div>
  );
}
