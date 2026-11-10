"use client";

import { useEffect, useState } from "react";
import type { ListCandidatesOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { ListPager } from "@/components/recruiter/ListPager";
import { MOMENTUM_PAGE } from "@/lib/triage-paging";
import { useFilterChips } from "@/lib/use-filter-chips";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { TriageCard } from "./TriageCard";
import { useScreeningScoreVisible } from "@/components/ScreeningScoreProvider";

/**
 * Below the Hot Zone in the single triage scroller (UX-01) — sorted by
 * AI score descending. No internal scroll of its own; its `sticky top-0`
 * header pins once the Hot Zone section has scrolled past. PC-5
 * replaced the old fixed limit=50 (HANDOVER deviation #54) with offset
 * paging: 50 per page, a server total, "Showing 51–100 of 412".
 *
 * Cache is updated optimistically by the drawer's Advance/Reject
 * mutations (see CandidateDetailDrawer's onMutate handler). Filter
 * chip changes re-fetch via React Query's automatic invalidation.
 */
export function MomentumFeed({ initial }: { initial: ListCandidatesOutput }) {
  const { filters } = useFilterChips();
  const { open, candidateId } = useDrawerRouting();

  const scoreVisible = useScreeningScoreVisible();
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [filters.requisitionId, filters.stage, filters.source]);
  const noFilters =
    filters.requisitionId === null && filters.stage === null && filters.source === null;
  const query = trpc.listCandidates.useQuery(
    {
      filters: {
        ...(filters.requisitionId ? { requisitionId: filters.requisitionId } : {}),
        ...(filters.stage ? { stage: filters.stage } : { stage: "application_received" }),
        ...(filters.source ? { source: filters.source } : {}),
      },
      pagination: { limit: MOMENTUM_PAGE, offset },
      sort: scoreVisible ? "ai_score_desc" : "recent",
    },
    {
      initialData: noFilters && offset === 0 ? initial : undefined,
      placeholderData: (prev) => prev,
    },
  );

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? rows.length;

  return (
    <section aria-label="Momentum feed">
      <header className="sticky top-0 z-sticky flex items-center gap-2.5 border-b border-neutral-200 bg-white/95 px-6 pb-2.5 pt-4 backdrop-blur">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-600">
          Momentum
        </h2>
        <span className="text-xs text-neutral-400">
          {scoreVisible
            ? "Fresh applications · highest AI score first"
            : "Fresh applications · newest first"}
        </span>
        {total > 0 ? (
          <ListPager
            className="ml-auto"
            offset={offset}
            limit={MOMENTUM_PAGE}
            shown={rows.length}
            total={total}
            onOffsetChange={setOffset}
            busy={query.isFetching}
          />
        ) : null}
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
