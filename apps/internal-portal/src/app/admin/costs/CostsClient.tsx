"use client";

import { useState, type ReactNode } from "react";
import type {
  GetAiUsageSummaryOutput,
  GetAiBudgetStatusOutput,
  GetAiBudgetOutput,
  AiBudgetStatus,
} from "@hireops/api-types";
import { Input } from "@hireops/ui";
import {
  Button,
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
import { trpc, handleTRPCError } from "@/lib/trpc-client";

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
export function CostsClient({
  initial,
  budgetStatusInitial,
  budgetInitial,
}: {
  initial: GetAiUsageSummaryOutput;
  budgetStatusInitial: GetAiBudgetStatusOutput;
  budgetInitial: GetAiBudgetOutput;
}) {
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
        Every Anthropic call logged with tokens and cost, per feature, per model. All time. Amounts
        in USD, computed from the per-call micro-cost ledger.
      </p>

      <BudgetPanel statusInitial={budgetStatusInitial} budgetInitial={budgetInitial} />

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
                    <Td label="Feature" className="font-mono text-xs">
                      {f.feature}
                    </Td>
                    <Td numeric label="Calls">
                      {f.calls.toLocaleString()}
                    </Td>
                    <Td numeric label="Tokens in">
                      {f.input_tokens.toLocaleString()}
                    </Td>
                    <Td numeric label="Tokens out">
                      {f.output_tokens.toLocaleString()}
                    </Td>
                    <Td numeric label="Cost">
                      {formatMicrosUsd(f.cost_micros)}
                    </Td>
                    <Td numeric label="Failures">
                      {f.failures.toLocaleString()}
                    </Td>
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
                    <Td label="Provider" className="font-mono text-xs">
                      {m.provider}
                    </Td>
                    <Td label="Model" className="font-mono text-xs">
                      {m.model}
                    </Td>
                    <Td numeric label="Calls">
                      {m.calls.toLocaleString()}
                    </Td>
                    <Td numeric label="Tokens in">
                      {m.input_tokens.toLocaleString()}
                    </Td>
                    <Td numeric label="Tokens out">
                      {m.output_tokens.toLocaleString()}
                    </Td>
                    <Td numeric label="Cost">
                      {formatMicrosUsd(m.cost_micros)}
                    </Td>
                    <Td numeric label="Failures">
                      {m.failures.toLocaleString()}
                    </Td>
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

/** Plain USD from a dollar number (budget amounts are whole/fractional dollars,
 * not micros). Two decimals — budgets are set in dollars, not sub-cents. */
function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

const STATUS_META: Record<
  AiBudgetStatus,
  { label: string; tone: "accent" | "warning" | "neutral" }
> = {
  off: { label: "Alerting off", tone: "neutral" },
  under: { label: "Under budget", tone: "neutral" },
  on_track: { label: "On track", tone: "accent" },
  over_projected: { label: "Over projected", tone: "warning" },
};

/**
 * T5.1 / G24 — the AI-budget panel: a server-COMPUTED spend-vs-budget status
 * (over the real ai_usage_logs ledger — flipping the budget flips the status)
 * plus a lean admin editor. The whole /admin/costs page is requireAdmin-gated,
 * so the editor renders unconditionally. Saving DRIVES both the status here and
 * the ai_budget_scan alert worker — the config is never decorative. Alerting
 * only: no hard cap that blocks AI calls (deferred as T5.1b).
 */
function BudgetPanel({
  statusInitial,
  budgetInitial,
}: {
  statusInitial: GetAiBudgetStatusOutput;
  budgetInitial: GetAiBudgetOutput;
}) {
  const utils = trpc.useUtils();
  const statusQuery = trpc.getAiBudgetStatus.useQuery(
    {},
    { initialData: statusInitial, refetchOnWindowFocus: false, staleTime: 5_000 },
  );
  const budgetQuery = trpc.getAiBudget.useQuery(
    {},
    { initialData: budgetInitial, refetchOnWindowFocus: false, staleTime: 5_000 },
  );
  const status = statusQuery.data ?? statusInitial;
  const budget = budgetQuery.data ?? budgetInitial;

  const [enabled, setEnabled] = useState(budget.enabled);
  const [amount, setAmount] = useState(String(budget.monthlyBudgetUsd));
  const [thresholds, setThresholds] = useState(budget.alertThresholdPercents.join(", "));
  const [notice, setNotice] = useState<string | null>(null);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum >= 0;
  const parsedThresholds = thresholds
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => Number(s));
  const thresholdsValid =
    parsedThresholds.length >= 1 &&
    parsedThresholds.length <= 5 &&
    parsedThresholds.every((n) => Number.isInteger(n) && n >= 1 && n <= 200);

  const update = trpc.updateAiBudget.useMutation({
    onSuccess: async () => {
      setNotice("Saved.");
      await Promise.all([utils.getAiBudget.invalidate(), utils.getAiBudgetStatus.invalidate()]);
    },
    onError: (err) => handleTRPCError(err, { onMessage: setNotice }),
  });

  function save() {
    setNotice(null);
    if (!amountValid || !thresholdsValid) {
      setNotice("Enter a non-negative budget and 1–5 whole-number percents (1–200).");
      return;
    }
    update.mutate({
      version: 1,
      enabled,
      monthlyBudgetUsd: amountNum,
      alertThresholdPercents: parsedThresholds,
    });
  }

  const statusMeta = STATUS_META[status.status];

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
        Monthly AI budget
      </h2>
      <Card className="space-y-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label="Monthly budget"
            value={formatUsd(status.monthlyBudgetUsd)}
            tone="accent"
          />
          <StatTile
            label="Spent this month"
            value={formatMicrosUsd(status.monthToDateSpendMicros)}
          />
          <StatTile
            label="Projected month-end"
            value={formatMicrosUsd(status.projectedMonthEndSpendMicros)}
          />
          <StatTile label="% of budget" value={`${status.percentOfBudget}%`} />
          <StatTile label="Status" value={statusMeta.label} tone={statusMeta.tone} />
        </div>

        <p className="text-xs text-neutral-500">
          The projection assumes spend continues at this month&apos;s daily rate. Budget alerts
          email the recipients configured in Admin → System Setup → Email Alerts (with the “AI
          budget” alert type enabled) once month-to-date spend crosses a threshold. This is an alert
          only, AI features are never blocked.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            Enable budget alerting
          </label>
          <Input
            label="Monthly budget (USD)"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={amountValid ? undefined : "Enter a non-negative amount."}
          />
          <Input
            label="Alert thresholds (% of budget)"
            value={thresholds}
            onChange={(e) => setThresholds(e.target.value)}
            placeholder="80, 100"
            error={thresholdsValid ? undefined : "1–5 whole percents (1–200)."}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={update.isPending} type="button">
            {update.isPending ? "Saving…" : "Save budget"}
          </Button>
          {notice ? <span className="text-sm text-neutral-600">{notice}</span> : null}
        </div>
      </Card>
    </section>
  );
}
