"use client";

import type { GetAiUsageSummaryOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";

/**
 * The admin AI-cost dashboard — summary tiles + per-feature / per-model
 * tables + a 14-day cost bar list, over the ai_usage_logs rollup
 * (getAiUsageSummary). Seeded from the server render (`initial`) for the
 * default all-time window and kept live by a plain tRPC query.
 *
 * Currency is USD only: cost_micros is USD micros (1 USD = 1,000,000
 * micros). No INR conversion — deliberately deferred (demo-polish decision).
 * cost_micros crosses the wire as a decimal string; formatted via Number()
 * which is exact at demo scale (micros in the thousands).
 *
 * The 14-day bars are widthed by cost (this is the TCO-per-day story), so a
 * zero-cost day — e.g. local-mode resume parses — reads as an empty row.
 */
export function CostsClient({ initial }: { initial: GetAiUsageSummaryOutput }) {
  const query = trpc.getAiUsageSummary.useQuery(
    {},
    {
      initialData: initial,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  );

  const data = query.data ?? initial;
  const { totals, byFeature, byModel, byDay } = data;
  const totalTokens = totals.input_tokens + totals.output_tokens;
  const hasUsage = totals.calls > 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <p className="mb-6 text-sm text-neutral-600">
        Every Anthropic call logged with tokens and cost — per feature, per model. All time.
        Amounts in USD, computed from the per-call micro-cost ledger.
      </p>

      {!hasUsage ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-6">
          <p className="text-sm text-neutral-500">No AI usage recorded.</p>
        </section>
      ) : (
        <>
          <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Total cost" value={formatMicrosUsd(totals.cost_micros)} tone="info" />
            <Tile label="Total calls" value={totals.calls.toLocaleString()} />
            <Tile label="Total tokens" value={totalTokens.toLocaleString()} />
            <Tile
              label="Failures"
              value={totals.failures.toLocaleString()}
              tone={totals.failures > 0 ? "warning" : "neutral"}
            />
            <Tile label="Avg latency" value={`${totals.avg_latency_ms.toLocaleString()} ms`} />
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              By feature
            </h2>
            <UsageTable
              headers={["Feature", "Calls", "Tokens in", "Tokens out", "Cost", "Failures"]}
              rows={byFeature.map((f) => ({
                key: f.feature,
                cells: [
                  <span key="f" className="font-mono text-xs text-neutral-800">
                    {f.feature}
                  </span>,
                  f.calls.toLocaleString(),
                  f.input_tokens.toLocaleString(),
                  f.output_tokens.toLocaleString(),
                  formatMicrosUsd(f.cost_micros),
                  f.failures.toLocaleString(),
                ],
              }))}
            />
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              By model
            </h2>
            <UsageTable
              headers={["Provider", "Model", "Calls", "Tokens in", "Tokens out", "Cost", "Failures"]}
              rows={byModel.map((m) => ({
                key: `${m.provider}/${m.model}`,
                cells: [
                  <span key="p" className="font-mono text-xs text-neutral-800">
                    {m.provider}
                  </span>,
                  <span key="m" className="font-mono text-xs text-neutral-800">
                    {m.model}
                  </span>,
                  m.calls.toLocaleString(),
                  m.input_tokens.toLocaleString(),
                  m.output_tokens.toLocaleString(),
                  formatMicrosUsd(m.cost_micros),
                  m.failures.toLocaleString(),
                ],
              }))}
            />
          </section>

          <section className="mb-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Last 14 days
            </h2>
            <DayBars days={byDay} />
          </section>
        </>
      )}
    </div>
  );
}

function DayBars({ days }: { days: GetAiUsageSummaryOutput["byDay"] }) {
  if (days.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <p className="text-sm text-neutral-500">No AI usage in the last 14 days.</p>
      </div>
    );
  }
  const maxCost = days.reduce((m, d) => Math.max(m, Number(d.cost_micros)), 0);
  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4">
      {days.map((d) => {
        const cost = Number(d.cost_micros);
        const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;
        return (
          <div key={d.day} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 font-mono text-neutral-600">{d.day}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-neutral-100">
              <div
                className="h-full rounded bg-status-info-400"
                style={{ width: `${pct}%` }}
                aria-hidden
              />
            </div>
            <span className="w-16 shrink-0 text-right text-neutral-500">
              {d.calls.toLocaleString()} {d.calls === 1 ? "call" : "calls"}
            </span>
            <span className="w-20 shrink-0 text-right font-medium text-neutral-800">
              {formatMicrosUsd(d.cost_micros)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UsageTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: { key: string; cells: React.ReactNode[] }[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            {headers.map((h, i) => (
              <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? "" : "text-right"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-neutral-100 last:border-0">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={`px-4 py-2 ${i === 0 ? "text-neutral-800" : "text-right tabular-nums text-neutral-700"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "info" | "warning";
}) {
  const toneClass =
    tone === "info"
      ? "border-status-info-200 bg-status-info-50 text-status-info-800"
      : tone === "warning"
        ? "border-status-warning-200 bg-status-warning-50 text-status-warning-800"
        : "border-neutral-200 bg-white text-neutral-800";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <p className="text-xs uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}

/**
 * micros → "$0.0135". USD micros, 1 USD = 1,000,000 micros. Four decimals
 * so sub-cent per-call costs stay visible (a Sonnet completion can cost
 * ~$0.0003). Number() is exact at demo scale.
 */
function formatMicrosUsd(micros: string): string {
  const usd = Number(micros) / 1_000_000;
  return `$${usd.toFixed(4)}`;
}
