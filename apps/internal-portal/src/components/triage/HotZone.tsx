"use client";

import { useMemo } from "react";
import type { ListCandidatesOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { useFilterChips } from "@/lib/use-filter-chips";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { Badge } from "@/components/ui";
import { TriageCard } from "./TriageCard";

/**
 * Pinned at top, max 40vh, internal scrollbar. Filter chips apply
 * here too, so an SLA breach for a filtered-out req disappears
 * from the recruiter's view rather than misleading them.
 *
 * Hot Zone uses the listCandidates({sort:'sla_breach', filters:{slaBreachOnly:true}})
 * call. Empty state is affirmative ("✓ No SLA breaches"), not absence.
 */
export function HotZone({ initial }: { initial: ListCandidatesOutput }) {
  const { filters } = useFilterChips();
  const { open, candidateId } = useDrawerRouting();

  const query = trpc.listCandidates.useQuery(
    {
      filters: {
        slaBreachOnly: true,
        ...(filters.requisitionId ? { requisitionId: filters.requisitionId } : {}),
        ...(filters.stage ? { stage: filters.stage } : {}),
        ...(filters.source ? { source: filters.source } : {}),
      },
      pagination: { limit: 20 },
      sort: "sla_breach",
    },
    {
      initialData:
        filters.requisitionId === null && filters.stage === null && filters.source === null
          ? initial
          : undefined,
    },
  );

  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);

  return (
    <section
      aria-label="SLA breaches"
      className="border-b border-neutral-200 bg-status-error-50/30"
    >
      <header className="flex items-center gap-2.5 px-6 pb-2.5 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-status-error-700">
          Hot Zone · SLA Breaches
        </h2>
        {rows.length > 0 ? (
          <Badge tone="error" pill className="tabular-nums">
            {rows.length}
          </Badge>
        ) : null}
      </header>
      <div className="max-h-[40vh] overflow-y-auto">
        {rows.length === 0 ? (
          <div
            role="status"
            className="flex items-center gap-2 px-6 pb-4 text-sm font-medium text-status-positive-700"
          >
            <span aria-hidden>✓</span> No SLA breaches — you&apos;re on top of it.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200/70">
            {rows.map((r) => (
              <li key={r.applicationId}>
                <TriageCard
                  row={r}
                  variant="breach"
                  selected={candidateId === r.candidateId}
                  onOpen={open}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
