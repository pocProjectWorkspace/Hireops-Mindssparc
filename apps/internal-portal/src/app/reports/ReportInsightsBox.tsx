"use client";

import { useState } from "react";
import type { ReportFilters, ReportInsightKey } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-20 — the "Insights" box at the top of a report section: 2–4 short
 * sentences written by the AI from the figures this report already computed.
 * Renders NOTHING when the feature is off, there is nothing to say, or the
 * model is unavailable — the report and its numbers never depend on it.
 *
 * "How this was written" discloses the method and lists the exact figures the
 * model was given, so a reader can check any number in a sentence against
 * the source figure.
 */
export function ReportInsightsBox({
  reportKey,
  filters,
}: {
  reportKey: ReportInsightKey;
  filters: ReportFilters;
}) {
  const [open, setOpen] = useState(false);
  const q = trpc.getReportInsights.useQuery(
    { reportKey, filters },
    { refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000, retry: false },
  );

  if (q.isLoading) {
    return (
      <div
        className="mb-4 h-12 animate-pulse rounded-card border border-brand-100 bg-brand-50/40 print:hidden"
        aria-label="Writing insights"
      />
    );
  }
  const data = q.data;
  if (!data || data.status !== "ok" || data.insights.length === 0) return null;

  return (
    <div className="mb-4 rounded-card border border-brand-200 bg-brand-50/50 px-4 py-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-800">Insights</h3>
        <button
          type="button"
          className="text-xs text-brand-700 underline-offset-2 hover:underline print:hidden"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="The AI saw only the figures listed here, never individual records or names. Every number in a sentence is checked against these figures; a sentence with any other number is removed."
        >
          How this was written
        </button>
      </div>
      <ul className="space-y-1 text-sm text-neutral-800">
        {data.insights.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-500" />
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
      {open ? (
        <div className="mt-3 border-t border-brand-100 pt-2 text-xs text-neutral-600 print:hidden">
          <p className="mb-2 max-w-3xl">
            Written by AI from the figures below only, which HireOps calculated from your live data
            for these filters. The AI never sees individual records, candidates or names. Every
            number in a sentence is checked against these figures, and any sentence carrying a
            different number is removed
            {data.dropped > 0 ? ` (${data.dropped} removed this time)` : ""}. Refreshed at most
            every 15 minutes · {data.promptVersion}
            {data.cached ? " · cached" : ""}.
          </p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {data.figures.map((f) => (
              <div key={f.key} className="flex justify-between gap-3">
                <dt className="truncate">{f.label}</dt>
                <dd className="tabular-nums text-neutral-800">
                  {f.value.toLocaleString()}
                  {f.unit === "percent" ? "%" : ""}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
