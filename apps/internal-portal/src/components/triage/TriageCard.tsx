"use client";

import type { ListCandidatesOutput } from "@hireops/api-types";
import { AIScoreBadge } from "./AIScoreBadge";

// Zod's z.unknown() typing makes the property optional in the inferred
// type, which the strict Row would otherwise reject. Loosen the prop
// shape to match what useQuery actually hands us per row.
type RawRow = ListCandidatesOutput["rows"][number];
type Row = Omit<RawRow, "aiScoreExplanation"> & { aiScoreExplanation?: unknown };

/**
 * Shared card layout used by both Hot Zone (with breach severity)
 * and Momentum Feed. Click anywhere on the card to open the drawer.
 * Distinct `variant` so HotZone gets the breach-red left rule.
 */
export function TriageCard({
  row,
  variant,
  onOpen,
}: {
  row: Row;
  variant: "breach" | "feed";
  onOpen: (ids: { candidateId: string; applicationId: string }) => void;
}) {
  const enteredAt = new Date(row.stageEnteredAt);
  const hours = Math.floor((Date.now() - enteredAt.getTime()) / (60 * 60 * 1000));
  const inStageLabel =
    hours < 1
      ? "<1h in stage"
      : hours < 48
        ? `${hours}h in stage`
        : `${Math.floor(hours / 24)}d in stage`;

  return (
    <button
      type="button"
      onClick={() => onOpen({ candidateId: row.candidateId, applicationId: row.applicationId })}
      className={
        "flex w-full items-center justify-between gap-4 border-b border-neutral-200 bg-white px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-neutral-50 " +
        (variant === "breach" ? "border-l-4 border-l-status-error-500" : "")
      }
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-neutral-900">
          {row.fullName ?? "(no name on file)"}
        </p>
        <p className="truncate text-xs text-neutral-600">
          {row.email ?? "—"} · {row.stage.replace(/_/g, " ")}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <AIScoreBadge score={row.aiScore} explanation={row.aiScoreExplanation} variant="card" />
        <span
          className={
            "rounded-md px-2 py-1 font-mono text-xs " +
            (variant === "breach"
              ? "bg-status-error-50 text-status-error-700"
              : "bg-neutral-100 text-neutral-600")
          }
        >
          {inStageLabel}
        </span>
      </div>
    </button>
  );
}
