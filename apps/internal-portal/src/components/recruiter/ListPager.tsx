"use client";

import { cn } from "@/components/ui";

/**
 * PC-5 — offset pager for the server-paged candidate lists (candidates-by-role,
 * triage Hot Zone / Momentum). "Showing 51–100 of 412" + Prev / Next, and an
 * optional page-size select. Purely presentational: the caller owns offset.
 */

export function pageRangeLabel(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `Showing 0 of ${total.toLocaleString("en-IN")}`;
  const from = offset + 1;
  const to = offset + shown;
  return `Showing ${from.toLocaleString("en-IN")}–${to.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}`;
}

export function ListPager({
  offset,
  limit,
  shown,
  total,
  onOffsetChange,
  pageSizes,
  onLimitChange,
  busy = false,
  className,
}: {
  offset: number;
  limit: number;
  /** Rows actually on this page. */
  shown: number;
  total: number;
  onOffsetChange: (offset: number) => void;
  pageSizes?: number[];
  onLimitChange?: (limit: number) => void;
  busy?: boolean;
  className?: string;
}) {
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const btn =
    "rounded-button border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-white";
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 text-xs text-neutral-600", className)}
      aria-busy={busy}
    >
      <span className="tabular-nums" aria-live="polite">
        {pageRangeLabel(offset, shown, total)}
      </span>
      {pageSizes && onLimitChange ? (
        <label className="flex items-center gap-1">
          <span className="sr-only">Rows per page</span>
          <select
            aria-label="Rows per page"
            value={limit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="rounded-button border border-neutral-300 bg-white px-1.5 py-1 text-xs text-neutral-700"
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        type="button"
        className={btn}
        disabled={!hasPrev || busy}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <button
        type="button"
        className={btn}
        disabled={!hasNext || busy}
        onClick={() => onOffsetChange(offset + limit)}
      >
        Next
      </button>
    </div>
  );
}
