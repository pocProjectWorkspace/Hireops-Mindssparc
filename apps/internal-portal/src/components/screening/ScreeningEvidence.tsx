"use client";

import { useState, type ReactNode } from "react";
import type {
  ScreeningEvidenceSummary,
  ScreeningEvidenceView,
  ScreeningQueue,
  ScreeningVerdictValue,
} from "@hireops/api-types";
import { Badge, type BadgeTone, cn } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-6 — evidence-based screening affordances. Screening shows EVIDENCE, not a
 * score (decision D2): for every requisition criterion the CV either shows it
 * (met), partly shows it, doesn't show it, or doesn't say enough (unclear) —
 * with a short reason and verbatim CV quotes that were checked against the CV
 * before being stored. Nothing here renders the 0–100 score.
 *
 *   ScreeningEvidenceChip     compact "Must-haves 4/5 met" for list rows
 *   ScreeningEvidenceToggle   that chip as a button that expands the list
 *   ScreeningEvidenceRows     lazily-fetched evidence list (list-row expander)
 *   ScreeningEvidenceSection  the candidate-detail drawer section
 *   ScreeningQueueBadge       "Screening 312 of 400…" for a requisition
 */

const VERDICT_LABEL: Record<ScreeningVerdictValue, string> = {
  met: "Met",
  partially_met: "Partially met",
  not_met: "Not met",
  unclear: "Unclear",
};
const VERDICT_TONE: Record<ScreeningVerdictValue, BadgeTone> = {
  met: "success",
  partially_met: "warning",
  not_met: "error",
  unclear: "neutral",
};
const VERDICT_ICON: Record<ScreeningVerdictValue, string> = {
  met: "✓",
  partially_met: "◐",
  not_met: "✕",
  unclear: "?",
};
const VERDICT_ICON_CLASS: Record<ScreeningVerdictValue, string> = {
  met: "bg-status-positive-50 text-status-positive-700",
  partially_met: "bg-status-warning-50 text-status-warning-800",
  not_met: "bg-status-error-50 text-status-error-700",
  unclear: "bg-neutral-100 text-neutral-600",
};

function chipTone(s: ScreeningEvidenceSummary): BadgeTone {
  if (s.criteriaCount === 0) return "neutral";
  if (s.met === s.criteriaCount) return "success";
  if (s.met + s.partiallyMet >= s.criteriaCount / 2) return "accent";
  return "warning";
}

function chipTitle(s: ScreeningEvidenceSummary): string {
  const parts = [
    `${s.met} met`,
    `${s.partiallyMet} partially met`,
    `${s.notMet} not met`,
    `${s.unclear} unclear`,
  ];
  const stale =
    s.status === "stale"
      ? " The requisition's criteria changed since this was produced; it is being refreshed."
      : "";
  return `${parts.join(" · ")} of ${s.criteriaCount} criteria, from the CV.${stale}`;
}

function chipText(s: ScreeningEvidenceSummary): string {
  if (s.criteriaCount === 0) return "No must-haves set";
  const partial = s.partiallyMet > 0 ? ` · ${s.partiallyMet} partial` : "";
  return `Must-haves ${s.met}/${s.criteriaCount} met${partial}`;
}

/** Compact evidence chip. `null` summary → "Not screened yet". */
export function ScreeningEvidenceChip({
  summary,
  className,
}: {
  summary: ScreeningEvidenceSummary | null | undefined;
  className?: string;
}) {
  if (!summary) {
    return <span className={cn("text-xs text-neutral-400", className)}>Not screened yet</span>;
  }
  return (
    <span title={chipTitle(summary)} className={cn("inline-flex items-center gap-1", className)}>
      <Badge tone={chipTone(summary)} pill>
        {chipText(summary)}
      </Badge>
      {summary.status === "stale" ? (
        <span className="text-[11px] text-neutral-400">updating</span>
      ) : null}
    </span>
  );
}

/** The chip as a disclosure button. Renders the plain chip when unscreened. */
export function ScreeningEvidenceToggle({
  summary,
  open,
  onToggle,
}: {
  summary: ScreeningEvidenceSummary | null | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  if (!summary || summary.criteriaCount === 0) return <ScreeningEvidenceChip summary={summary} />;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      className="inline-flex items-center gap-1 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
    >
      <ScreeningEvidenceChip summary={summary} />
      <span className="text-xs text-neutral-400" aria-hidden>
        {open ? "▾" : "▸"}
      </span>
      <span className="sr-only">{open ? "Hide evidence" : "Show evidence"}</span>
    </button>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="mt-1 border-l-2 border-brand-200 pl-2 text-sm italic text-neutral-700">
      “{children}”
    </blockquote>
  );
}

/** The per-criterion list: verdict icon, criterion, reason, verified quotes. */
export function ScreeningEvidenceList({ evidence }: { evidence: ScreeningEvidenceView }) {
  if (evidence.criteria.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        This requisition has no must-have skills or required qualifications to screen against.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {evidence.criteria.map((c) => (
        <li key={c.key} className="flex gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
              VERDICT_ICON_CLASS[c.verdict],
            )}
            aria-label={VERDICT_LABEL[c.verdict]}
            role="img"
          >
            {VERDICT_ICON[c.verdict]}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-neutral-900">{c.label}</span>
              <Badge tone={VERDICT_TONE[c.verdict]}>{VERDICT_LABEL[c.verdict]}</Badge>
              {c.kind === "requirement" ? (
                <span className="text-[11px] uppercase tracking-wide text-neutral-400">
                  JD requirement
                </span>
              ) : null}
            </div>
            {c.reason ? <p className="mt-0.5 text-sm text-neutral-600">{c.reason}</p> : null}
            {c.quotes.map((q, i) => (
              <Quote key={i}>{q}</Quote>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Provenance({ evidence }: { evidence: ScreeningEvidenceView }) {
  return (
    <p className="mt-3 text-xs text-neutral-500">
      Quotes are copied from the parsed CV and checked word-for-word before they are shown
      {evidence.quotesDropped > 0
        ? `; ${evidence.quotesDropped} that could not be verified ${evidence.quotesDropped === 1 ? "was" : "were"} removed`
        : ""}
      . A criterion with no verifiable quote is marked unclear. Evidence for a human decision, not a
      verdict.
      {evidence.model ? (
        <>
          {" "}
          Generated by <span className="font-mono">{evidence.model}</span> ({evidence.promptVersion}
          ).
        </>
      ) : null}
    </p>
  );
}

/** Candidate-detail drawer section. */
export function ScreeningEvidenceSection({
  evidence,
}: {
  evidence: ScreeningEvidenceView | null | undefined;
}) {
  return (
    <section
      aria-labelledby="screening-evidence-heading"
      className="rounded-lg border border-neutral-200 bg-white p-4"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="screening-evidence-heading" className="text-sm font-semibold text-neutral-900">
          Screening evidence
        </h3>
        {evidence ? <ScreeningEvidenceChip summary={evidence} /> : null}
      </header>
      {!evidence ? (
        <p className="text-sm text-neutral-600">
          This CV has not been screened against the requisition&apos;s must-haves yet.
        </p>
      ) : (
        <>
          {evidence.status === "stale" ? (
            <p className="mb-3 rounded-md bg-status-warning-50 px-3 py-2 text-xs text-status-warning-800">
              The requisition&apos;s criteria changed after this evidence was produced. It has been
              queued for a refresh; the previous evidence is shown until then.
            </p>
          ) : null}
          <ScreeningEvidenceList evidence={evidence} />
          <Provenance evidence={evidence} />
        </>
      )}
    </section>
  );
}

/** Lazily fetches and renders one application's evidence (list-row expander). */
export function ScreeningEvidenceRows({ applicationId }: { applicationId: string }) {
  const q = trpc.getApplicationScreeningEvidence.useQuery({ applicationId });
  if (q.isLoading) return <p className="text-sm text-neutral-500">Loading evidence…</p>;
  if (q.error) return <p className="text-sm text-status-error-700">Could not load the evidence.</p>;
  const evidence = q.data?.evidence ?? null;
  if (!evidence) return <p className="text-sm text-neutral-500">Not screened yet.</p>;
  return (
    <div className="max-w-3xl">
      <ScreeningEvidenceList evidence={evidence} />
      <Provenance evidence={evidence} />
    </div>
  );
}

/** Hook for a list with per-row expanders: one open set, toggled by id. */
export function useExpandedSet(): [Set<string>, (id: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return [open, toggle];
}

/** "Screening 312 of 400…" while the requisition's CVs are still being screened. */
export function ScreeningQueueBadge({ queue }: { queue: ScreeningQueue | undefined }) {
  if (!queue || queue.pending === 0) return null;
  const done = queue.total - queue.pending;
  return (
    <Badge tone="info" pill>
      Screening {done} of {queue.total}…
    </Badge>
  );
}
