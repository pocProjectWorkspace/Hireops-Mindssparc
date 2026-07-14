"use client";

import { useEffect, useRef } from "react";
import type { ListCandidatesOutput } from "@hireops/api-types";
import { Avatar, Badge, ScoreMeter, cn } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

// Zod's z.unknown() typing makes the property optional in the inferred
// type, which the strict Row would otherwise reject. Loosen the prop
// shape to match what useQuery actually hands us per row.
type RawRow = ListCandidatesOutput["rows"][number];
type Row = Omit<RawRow, "aiScoreExplanation"> & { aiScoreExplanation?: unknown };

function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Time-in-stage: label + a Badge tone that escalates with SLA pressure.
 * Breach rows are always error-toned; feed rows warm up as they age.
 */
function timeInStage(
  stageEnteredAt: string,
  variant: "breach" | "feed",
): {
  label: string;
  tone: BadgeTone;
} {
  const hours = Math.floor((Date.now() - new Date(stageEnteredAt).getTime()) / (60 * 60 * 1000));
  const label =
    hours < 1
      ? "<1h in stage"
      : hours < 48
        ? `${hours}h in stage`
        : `${Math.floor(hours / 24)}d in stage`;
  if (variant === "breach") return { label, tone: "error" };
  const tone: BadgeTone = hours >= 72 ? "error" : hours >= 24 ? "warning" : "neutral";
  return { label, tone };
}

/**
 * A candidate row shared by the Hot Zone (SLA-breach) and Momentum feed.
 * Initials avatar · name (prominent) · email + stage Badge (secondary) on
 * the left; AI score meter + escalating time-in-stage Badge on the right.
 * The whole row is one button — click anywhere opens the drawer. Breach
 * rows carry a red left rule.
 */
export function TriageCard({
  row,
  variant,
  selected = false,
  onOpen,
}: {
  row: Row;
  variant: "breach" | "feed";
  selected?: boolean;
  onOpen: (ids: { candidateId: string; applicationId: string }) => void;
}) {
  const name = row.fullName ?? "(no name on file)";
  const { label: inStageLabel, tone: inStageTone } = timeInStage(row.stageEnteredAt, variant);

  // UX-01: pull the selected row into view within the single triage
  // scroller — chiefly for a `?candidateId=` deep link that lands with a
  // row selected below the fold. `block: "nearest"` is a no-op when the
  // row is already visible, so clicking a visible row never jerks the feed.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen({ candidateId: row.candidateId, applicationId: row.applicationId })}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3 px-6 py-3 text-left transition-colors",
        "focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand-500",
        variant === "breach" && "border-l-2 border-l-status-error-500",
        selected ? "bg-brand-50" : "hover:bg-neutral-50",
      )}
    >
      <Avatar name={name} seed={row.candidateId} size="md" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-neutral-900">{name}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-neutral-500">{row.email ?? "—"}</span>
          <Badge tone="neutral" className="shrink-0">
            {stageLabel(row.stage)}
          </Badge>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4">
        <ScoreMeter score={row.aiScore} />
        <Badge tone={inStageTone} pill className="tabular-nums">
          {inStageLabel}
        </Badge>
      </div>
    </button>
  );
}
