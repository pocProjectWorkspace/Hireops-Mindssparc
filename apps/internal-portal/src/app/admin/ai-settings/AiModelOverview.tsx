"use client";

import { AI_MODEL_ALLOWLIST, type GetAiUsageSummaryOutput } from "@hireops/api-types";
import { Card, Badge, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";

/**
 * AiModelOverview (AD-01, AD4 + AD7) — two DESIGN-05 cards at the top of the
 * AI-settings page:
 *
 *   · Model & provider (AD4): the provider is FIXED to Anthropic (Claude) and
 *     the model allowlist is Anthropic-only. The prototype's OpenAI / gpt-4.1
 *     option is REFUSED — offering models we don't run would be dishonest, and
 *     an Anthropic-only stance is part of the EU AI Act selling point. Provider
 *     is displayed read-only here; per-feature model selection lives in the
 *     cards below, drawn from this same allowlist.
 *
 *   · AI feature usage (AD7): the last-30-day getAiUsageSummary rollup, per
 *     feature (calls / tokens / cost USD). Cost is USD — Anthropic bills USD,
 *     so this figure stays in dollars even though the rest of the product is
 *     INR. Links to /admin/costs for the full per-model + daily breakdown.
 */
export function AiModelOverview({ usage }: { usage: GetAiUsageSummaryOutput }) {
  const { byFeature, totals } = usage;
  const totalTokens = totals.input_tokens + totals.output_tokens;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-8">
      <Card className="mb-4 p-5">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-900">Model &amp; provider</h2>
          <Badge tone="accent">Anthropic</Badge>
        </div>
        <p className="mb-4 text-xs text-neutral-600">
          The AI provider is fixed to Anthropic (Claude). OpenAI / GPT models are deliberately not
          offered — we only surface models we actually run, and an Anthropic-only posture is part of
          the EU AI Act compliance story. Each feature below picks its model from this allowlist.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-card border border-neutral-200 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Provider</p>
            <p className="mt-1 text-sm font-medium text-neutral-900">Anthropic</p>
          </div>
          <div className="rounded-card border border-neutral-200 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Allowed models
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {AI_MODEL_ALLOWLIST.map((m) => (
                <Badge key={m} tone="neutral">
                  {m}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-900">AI feature usage</h2>
          <a href="/admin/costs" className="text-xs font-medium text-brand-700 hover:underline">
            Full cost breakdown →
          </a>
        </div>
        <p className="mb-4 text-xs text-neutral-600">
          Every Anthropic call is logged with tokens and cost. Amounts in USD (Anthropic bills USD).
          All time · {totals.calls.toLocaleString()} {totals.calls === 1 ? "call" : "calls"} ·{" "}
          {totalTokens.toLocaleString()} tokens · {totals.avg_latency_ms.toLocaleString()} ms avg
          latency.
        </p>
        {byFeature.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No AI usage recorded yet. Calls appear here once scoring, JD generation or an agent
            draft runs against a live credential.
          </p>
        ) : (
          <TableShell>
            <Thead>
              <Th>Feature</Th>
              <Th numeric>Calls</Th>
              <Th numeric>Tokens</Th>
              <Th numeric>Cost (USD)</Th>
              <Th numeric>Failures</Th>
            </Thead>
            <Tbody>
              {byFeature.map((f) => (
                <Tr key={f.feature}>
                  <Td className="font-mono text-xs">{f.feature}</Td>
                  <Td numeric>{f.calls.toLocaleString()}</Td>
                  <Td numeric>{(f.input_tokens + f.output_tokens).toLocaleString()}</Td>
                  <Td numeric>{formatMicrosUsd(f.cost_micros)}</Td>
                  <Td numeric>{f.failures.toLocaleString()}</Td>
                </Tr>
              ))}
            </Tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}

/** micros → "$0.0135". USD micros, 1 USD = 1,000,000 micros. */
function formatMicrosUsd(micros: string): string {
  return `$${(Number(micros) / 1_000_000).toFixed(4)}`;
}
