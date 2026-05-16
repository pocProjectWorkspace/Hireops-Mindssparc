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
  const { open } = useDrawerRouting();

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
      <header className="border-b border-neutral-200 bg-white px-6 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700">
          Momentum
        </h2>
      </header>
      {rows.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-neutral-500">
          No new applications. Check back later.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-200">
          {rows.map((r) => (
            <li key={r.applicationId}>
              <TriageCard row={r} variant="feed" onOpen={open} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
