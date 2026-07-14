"use client";

import type { ReactNode } from "react";
import type { GetAiUsageSummaryOutput } from "@hireops/api-types";
import {
  Card,
  DataBar,
  EmptyState,
  StatTile,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
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
 *
 * DESIGN-03: tiles → StatTile (accent Total cost, warning Failures), tables →
 * TableShell, the 14-day bars → the shared DataBar (one bar language with the
 * reports funnel).
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
        Every Anthropic call logged with tokens and cost — per feature, per model. All time. Amounts
        in USD, computed from the per-call micro-cost ledger.
      </p>

      {!hasUsage ? (
        <Card padded={false}>
          <EmptyState
            title="No AI usage recorded"
            hint="Calls appear here once an agent drafts or scoring runs against a live credential."
          />
        </Card>
      ) : (
        <>
          <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile
              label="Total cost"
              value={formatMicrosUsd(totals.cost_micros)}
              tone="accent"
            />
            <StatTile label="Total calls" value={totals.calls.toLocaleString()} />
            <StatTile label="Total tokens" value={totalTokens.toLocaleString()} />
            <StatTile
              label="Failures"
              value={totals.failures.toLocaleString()}
              tone={totals.failures > 0 ? "warning" : "neutral"}
            />
            <StatTile label="Avg latency" value={`${totals.avg_latency_ms.toLocaleString()} ms`} />
          </section>

          <Section title="By feature">
            <TableShell>
              <Thead>
                <Th>Feature</Th>
                <Th numeric>Calls</Th>
                <Th numeric>Tokens in</Th>
                <Th numeric>Tokens out</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Failures</Th>
              </Thead>
              <Tbody>
                {byFeature.map((f) => (
                  <Tr key={f.feature}>
                    <Td className="font-mono text-xs">{f.feature}</Td>
                    <Td numeric>{f.calls.toLocaleString()}</Td>
                    <Td numeric>{f.input_tokens.toLocaleString()}</Td>
                    <Td numeric>{f.output_tokens.toLocaleString()}</Td>
                    <Td numeric>{formatMicrosUsd(f.cost_micros)}</Td>
                    <Td numeric>{f.failures.toLocaleString()}</Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
          </Section>

          <Section title="By model">
            <TableShell>
              <Thead>
                <Th>Provider</Th>
                <Th>Model</Th>
                <Th numeric>Calls</Th>
                <Th numeric>Tokens in</Th>
                <Th numeric>Tokens out</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Failures</Th>
              </Thead>
              <Tbody>
                {byModel.map((m) => (
                  <Tr key={`${m.provider}/${m.model}`}>
                    <Td className="font-mono text-xs">{m.provider}</Td>
                    <Td className="font-mono text-xs">{m.model}</Td>
                    <Td numeric>{m.calls.toLocaleString()}</Td>
                    <Td numeric>{m.input_tokens.toLocaleString()}</Td>
                    <Td numeric>{m.output_tokens.toLocaleString()}</Td>
                    <Td numeric>{formatMicrosUsd(m.cost_micros)}</Td>
                    <Td numeric>{m.failures.toLocaleString()}</Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
          </Section>

          <Section title="Last 14 days">
            <DayBars days={byDay} />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
        {title}
      </h2>
      {children}
    </section>
  );
}

function DayBars({ days }: { days: GetAiUsageSummaryOutput["byDay"] }) {
  if (days.length === 0) {
    return (
      <Card padded={false}>
        <EmptyState title="No AI usage in the last 14 days" />
      </Card>
    );
  }
  const maxCost = days.reduce((m, d) => Math.max(m, Number(d.cost_micros)), 0);
  return (
    <Card className="space-y-2.5">
      {days.map((d) => {
        const cost = Number(d.cost_micros);
        const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;
        return (
          <DataBar
            key={d.day}
            label={d.day}
            monoLabel
            labelClassName="w-24 text-neutral-600"
            pct={pct}
            meta={`${d.calls.toLocaleString()} ${d.calls === 1 ? "call" : "calls"}`}
            value={formatMicrosUsd(d.cost_micros)}
          />
        );
      })}
    </Card>
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
