"use client";

import { useMemo } from "react";
import { trpc } from "@/lib/trpc-client";
import type { IrisProvenanceRow } from "@hireops/api-types";
import { indexProvenance, provenanceTooltip } from "./provenance";

/**
 * AiAssistedPill (IRIS-A2) — the `✨ AI-assisted` provenance pill. Persisted-
 * and-consumed: it renders ONLY for an entity that carries an Iris provenance
 * row (created via irisExecute). Human-made entities have no row → no pill.
 */

/**
 * Batch-fetch provenance for a set of entity ids and return a fast lookup map.
 * Skips the call entirely when there are no ids (the query requires ≥1). Used
 * by list surfaces to render one pill per row without N queries.
 */
export function useProvenanceMap(
  entityType: string,
  entityIds: string[],
): Map<string, IrisProvenanceRow> {
  const ids = useMemo(() => Array.from(new Set(entityIds)), [entityIds]);
  const query = trpc.irisGetProvenance.useQuery(
    { entityType, entityIds: ids },
    { enabled: ids.length > 0 },
  );
  return useMemo(() => indexProvenance(query.data?.rows ?? []), [query.data]);
}

/** The pill itself. Renders nothing unless `row` is present (the honesty flip). */
export function AiAssistedPill({
  row,
  className,
}: {
  row: IrisProvenanceRow | undefined;
  className?: string;
}) {
  if (!row) return null;
  return (
    <span
      title={provenanceTooltip(row)}
      className={
        "inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-inset ring-brand-100" +
        (className ? ` ${className}` : "")
      }
    >
      <span aria-hidden>✨</span>
      AI-assisted
    </span>
  );
}
