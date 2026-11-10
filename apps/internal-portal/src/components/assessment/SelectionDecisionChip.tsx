"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import {
  SELECTION_DECISION_LABELS,
  type LatestSelectionDecision,
  type SelectionDecision,
} from "@hireops/api-types";

/**
 * PC-12 — the latest explicit selection decision as a chip. Purely additive:
 * renders nothing when there is no decision (or the read failed, e.g. before
 * migration 0129 is applied).
 */

const TONE: Record<SelectionDecision, BadgeTone> = {
  selected: "success",
  not_selected: "error",
  on_hold: "warning",
};

/** Short label for dense lists; the drawer uses the full label. */
const SHORT_LABEL: Record<SelectionDecision, string> = {
  selected: "Selected",
  not_selected: "Not selected",
  on_hold: "On hold",
};

export function SelectionDecisionChip({
  decision,
  reasonLabel,
  compact = false,
}: {
  decision: SelectionDecision;
  reasonLabel?: string | null;
  compact?: boolean;
}) {
  const label = compact ? SHORT_LABEL[decision] : SELECTION_DECISION_LABELS[decision];
  return (
    <span title={reasonLabel ? `${SELECTION_DECISION_LABELS[decision]} · ${reasonLabel}` : label}>
      <Badge tone={TONE[decision]}>{label}</Badge>
    </span>
  );
}

/** Batched latest-decision read for a list of applications (one query). */
export function useLatestSelectionDecisions(
  applicationIds: string[],
): Map<string, LatestSelectionDecision> {
  const ids = useMemo(() => Array.from(new Set(applicationIds)).slice(0, 500), [applicationIds]);
  const query = trpc.listLatestSelectionDecisions.useQuery(
    { applicationIds: ids },
    { enabled: ids.length > 0, retry: false },
  );
  return useMemo(
    () => new Map((query.data?.rows ?? []).map((r) => [r.applicationId, r] as const)),
    [query.data],
  );
}
