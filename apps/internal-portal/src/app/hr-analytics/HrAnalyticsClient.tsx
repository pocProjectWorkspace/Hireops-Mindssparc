"use client";

import dynamic from "next/dynamic";
import type { GetHrAnalyticsOutput } from "@hireops/api-types";
import { StatTile } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * HROPS-02 /hr-analytics — a KPI header over the getHrAnalytics aggregate, then
 * the recharts grid. The KPI tiles render immediately; the chart grid is
 * code-split (next/dynamic ssr:false) so recharts stays out of first-load JS.
 * Seeded from the server render and kept live by a plain tRPC query.
 */

const AnalyticsCharts = dynamic(() => import("./AnalyticsCharts").then((m) => m.AnalyticsCharts), {
  ssr: false,
  loading: () => <ChartGridSkeleton />,
});

export function HrAnalyticsClient({ initial }: { initial: GetHrAnalyticsOutput }) {
  const query = trpc.getHrAnalytics.useQuery(undefined, {
    initialData: initial,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });
  const data = query.data ?? initial;
  const { kpis } = data;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <p className="mb-6 text-sm text-neutral-600">
        Real hiring analytics over the live pipeline, offers and comp band data. Every panel is a
        current snapshot; there are no fabricated numbers — thin data shows an honest empty state.
      </p>

      <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="On comp desk" value={kpis.onDesk.toLocaleString()} tone="accent" />
        <StatTile label="Offers out" value={kpis.offersOut.toLocaleString()} />
        <StatTile label="Need approval" value={kpis.needApproval.toLocaleString()} tone="warning" />
        <StatTile
          label="Offer acceptance"
          value={kpis.acceptanceRatePct == null ? "—" : `${kpis.acceptanceRatePct}%`}
        />
      </section>

      <AnalyticsCharts data={data} />
    </div>
  );
}

function ChartGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-[300px] animate-pulse rounded-card border border-neutral-200 bg-neutral-100"
        />
      ))}
    </div>
  );
}
