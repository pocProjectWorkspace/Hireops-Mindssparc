"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { GetRequisitionInsightsOutput } from "@hireops/api-types";
import { StatTile } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * RO-03 — /insights client. A requisition selector ("All my requisitions" or a
 * single req) over a KPI strip and the code-split chart grid. The KPI tiles
 * paint immediately; the recharts grid streams in after (ssr:false), matching
 * the /metrics pattern.
 */

const InsightsCharts = dynamic(() => import("./InsightsCharts").then((m) => m.InsightsCharts), {
  ssr: false,
  loading: () => <ChartsSkeleton />,
});

export function InsightsClient({ initial }: { initial: GetRequisitionInsightsOutput }) {
  const [reqId, setReqId] = useState<string | null>(null);

  const query = trpc.getRequisitionInsights.useQuery(
    { requisitionId: reqId },
    {
      initialData: reqId === null ? initial : undefined,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  );

  const data = query.data ?? initial;
  const options = initial.reqOptions.length > 0 ? initial.reqOptions : data.reqOptions;
  const { kpis } = data;

  const timeToHire = kpis.avgTimeToHireDays;
  const fillPct =
    kpis.fillRate.openings > 0
      ? Math.round((kpis.fillRate.hires / kpis.fillRate.openings) * 100)
      : null;
  const acceptPct =
    kpis.offerAcceptRate.extended > 0
      ? Math.round((kpis.offerAcceptRate.accepted / kpis.offerAcceptRate.extended) * 100)
      : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-600">
          Analytics across your requisitions. Pick one for its funnel, skill gaps, salary band and
          panel trends, or keep the rollup.
        </p>
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          <span className="whitespace-nowrap">Requisition</span>
          <select
            value={reqId ?? ""}
            onChange={(e) => setReqId(e.target.value === "" ? null : e.target.value)}
            className="h-9 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-500"
          >
            <option value="">All my requisitions</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title ?? "Untitled role"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Avg time to hire"
          value={timeToHire === null ? "—" : `${timeToHire}d`}
          hint="Historical average"
          tone="accent"
        />
        <StatTile
          label="Fill rate"
          value={fillPct === null ? "—" : `${fillPct}%`}
          hint={`${kpis.fillRate.hires} hired / ${kpis.fillRate.openings} opening${kpis.fillRate.openings === 1 ? "" : "s"}`}
        />
        <StatTile label="Active candidates" value={kpis.activeCandidates.toLocaleString()} />
        <StatTile
          label="Offer accept rate"
          value={acceptPct === null ? "—" : `${acceptPct}%`}
          hint={`${kpis.offerAcceptRate.accepted} accepted / ${kpis.offerAcceptRate.extended} extended`}
        />
      </section>

      <InsightsCharts data={data} />
    </div>
  );
}

function ChartsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-[300px] animate-pulse rounded-card border border-neutral-200 bg-neutral-100"
        />
      ))}
    </div>
  );
}
