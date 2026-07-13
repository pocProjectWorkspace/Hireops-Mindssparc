"use client";

import type { ListCandidatesOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { useFilterChips } from "@/lib/use-filter-chips";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { TriageCard } from "./TriageCard";

/**
 * Below the Hot Zone divider — sorted by AI score descending. Wave 1
 * uses a single fetch (limit=50) instead of useInfiniteQuery; the
 * "load more" affordance + cursor-paginated fetchNextPage lands when
 * a recruiter complains about hitting the cap. Documented in
 * HANDOVER as deviation #54 from the ticket's infinite-scroll lean.
 *
 * Cache is updated optimistically by the drawer's Advance/Reject
 * mutations (see CandidateDetailDrawer's onMutate handler). Filter
 * chip changes re-fetch via React Query's automatic invalidation.
 */
export function MomentumFeed({ initial }: { initial: ListCandidatesOutput }) {
  const { filters } = useFilterChips();
  const { open, candidateId } = useDrawerRouting();

  const query = trpc.listCandidates.useQuery(
    {
      filters: {
        ...(filters.requisitionId ? { requisitionId: filters.requisitionId } : {}),
        ...(filters.stage ? { stage: filters.stage } : { stage: "application_received" }),
        ...(filters.source ? { source: filters.source } : {}),
      },
      pagination: { limit: 50 },
      sort: "ai_score_desc",
    },
    {
      initialData:
        filters.requisitionId === null && filters.stage === null && filters.source === null
          ? initial
          : undefined,
    },
  );

  const rows = query.data?.rows ?? [];

  return (
    <section aria-label="Momentum feed" className="flex-1 overflow-y-auto">
      <header className="sticky top-0 z-sticky flex items-center gap-2.5 border-b border-neutral-200 bg-white/95 px-6 pb-2.5 pt-4 backdrop-blur">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-600">
          Momentum
        </h2>
        <span className="text-xs text-neutral-400">
          Fresh applications · highest AI score first
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-neutral-500">
          No new applications. Check back later.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <li key={r.applicationId}>
              <TriageCard
                row={r}
                variant="feed"
                selected={candidateId === r.candidateId}
                onOpen={open}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
