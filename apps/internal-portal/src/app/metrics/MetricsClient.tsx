"use client";

import dynamic from "next/dynamic";
import type { GetHrMetricsOutput } from "@hireops/api-types";
import { StatTile } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * The /metrics analytics surface — a KPI header row over an aggregate read
 * (getHrMetrics), then the recharts chart grid.
 *
 * The KPI tiles render immediately (no charting library in that path). The
 * chart grid is code-split with next/dynamic + ssr:false so recharts (heavy)
 * stays out of this route's first-load JS — the grid's bundle streams in
 * after the shell + KPIs paint. Seeded from the server render (`initial`)
 * and kept live by a plain tRPC query, exactly like the Costs / Reports
 * surfaces.
 */

const ChartGrid = dynamic(() => import("./ChartGrid").then((m) => m.ChartGrid), {
  ssr: false,
  loading: () => <ChartGridSkeleton />,
});

export function MetricsClient({ initial }: { initial: GetHrMetricsOutput }) {
  const query = trpc.getHrMetrics.useQuery(undefined, {
    initialData: initial,
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  });

  const data = query.data ?? initial;
  const { kpis } = data;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <p className="mb-6 text-sm text-neutral-600">
        Hiring pipeline, sourcing, offers and AI usage across the tenant. Pipeline, source, offer
        and score panels are a current snapshot (all time); AI spend is the last 14 days.
      </p>

      <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Applications" value={kpis.applications.toLocaleString()} tone="accent" />
        <StatTile label="Active in pipeline" value={kpis.active.toLocaleString()} />
        <StatTile label="Hires" value={kpis.hired.toLocaleString()} />
        <StatTile label="Offers extended" value={kpis.offers_extended.toLocaleString()} />
        <StatTile
          label="Avg AI score"
          value={kpis.avg_ai_score === null ? "—" : kpis.avg_ai_score.toLocaleString()}
        />
      </section>

      <ChartGrid data={data} />
    </div>
  );
}

/** Placeholder shown while the recharts grid code-splits in. Matches the grid
 * geometry (2 columns, six ~300px panels) so the layout doesn't jump. */
function ChartGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-[300px] animate-pulse rounded-card border border-neutral-200 bg-neutral-100"
        />
      ))}
    </div>
  );
}
