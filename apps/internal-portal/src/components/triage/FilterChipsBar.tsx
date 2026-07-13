"use client";

import { applicationSourceSchema, applicationStageSchema } from "@hireops/api-types";
import type { ApplicationSource, ApplicationStage } from "@hireops/api-types";
import { useFilterChips } from "@/lib/use-filter-chips";

/**
 * Sticky bar above the Hot Zone. Three native <select>s — Radix
 * dropdown overkill for Wave 1; switch when a recruiter asks for
 * multi-select or search-as-you-type. Native selects come with
 * keyboard accessibility for free.
 *
 * State lives in URL search params (useFilterChips) so chip changes
 * coexist with the drawer's ?candidateId. Clear-all button appears
 * only when any filter is active.
 */

const STAGES = applicationStageSchema.options as readonly ApplicationStage[];
const SOURCES = applicationSourceSchema.options as readonly ApplicationSource[];

export function FilterChipsBar({
  requisitionOptions = [],
}: {
  /** Caller passes the list of requisitions visible to the recruiter.
   * Empty list shrinks the chip to a "no reqs available" disabled state. */
  requisitionOptions?: { id: string; label: string }[];
}) {
  const { filters, set, clearAll, isAnyActive } = useFilterChips();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-6 py-3">
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">Filter</span>

      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Requisition</span>
        <select
          aria-label="Filter by requisition"
          value={filters.requisitionId ?? ""}
          onChange={(e) => set({ requisitionId: e.target.value || null })}
          disabled={requisitionOptions.length === 0}
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100 disabled:text-neutral-400"
        >
          <option value="">All requisitions</option>
          {requisitionOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Stage</span>
        <select
          aria-label="Filter by stage"
          value={filters.stage ?? ""}
          onChange={(e) => set({ stage: (e.target.value || null) as ApplicationStage | null })}
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        >
          <option value="">All stages</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Source</span>
        <select
          aria-label="Filter by source"
          value={filters.source ?? ""}
          onChange={(e) => set({ source: (e.target.value || null) as ApplicationSource | null })}
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        >
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>

      {isAnyActive && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-auto rounded-md px-2 py-1 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
