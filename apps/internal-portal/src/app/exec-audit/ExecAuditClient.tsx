"use client";

import { useMemo, useState } from "react";
import type { GetExecutiveAuditOutput, RiskSeverity } from "@hireops/api-types";
import { StatTile, Card, Badge, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { BadgeTone, StatTileTone } from "@/components/ui";

/**
 * HRHEAD-03 — Executive Audit dashboard (client). Compliance score composite,
 * a KPI row, the risk-alert feed with severity filter tabs, the per-stage SLA
 * compliance table, and top drop-off reasons. Numbers are server-computed;
 * this component only presents + filters.
 */

const SEVERITY_TONE: Record<RiskSeverity, BadgeTone> = {
  high: "error",
  medium: "warning",
  low: "info",
};

type SeverityFilter = "all" | RiskSeverity;

export function ExecAuditClient({ audit }: { audit: GetExecutiveAuditOutput }) {
  const [filter, setFilter] = useState<SeverityFilter>("all");

  const filteredFlags = useMemo(
    () => (filter === "all" ? audit.flags : audit.flags.filter((f) => f.severity === filter)),
    [audit.flags, filter],
  );

  const scoreTone: StatTileTone =
    audit.kpis.complianceScore >= 85
      ? "positive"
      : audit.kpis.complianceScore >= 60
        ? "warning"
        : "error";

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Compliance score"
          value={`${audit.kpis.complianceScore}`}
          hint="weighted composite / 100"
          tone={scoreTone}
        />
        <StatTile
          label="SLA breaches"
          value={audit.kpis.slaBreaches}
          hint="applications past their stage SLA"
          tone={audit.kpis.slaBreaches > 0 ? "warning" : "neutral"}
        />
        <StatTile
          label="Open risk flags"
          value={audit.kpis.openFlags}
          hint={`${audit.flagCounts.high} high · ${audit.flagCounts.medium} med`}
          tone={
            audit.flagCounts.high > 0 ? "error" : audit.kpis.openFlags > 0 ? "warning" : "neutral"
          }
        />
        <StatTile
          label="Offer accept rate"
          value={audit.kpis.offerAcceptRatePct === null ? "—" : `${audit.kpis.offerAcceptRatePct}%`}
          hint="accepted / decided offers"
        />
      </div>

      {/* Compliance composite */}
      <section className="mt-10">
        <h2 className="text-base font-semibold text-neutral-900">Compliance score composite</h2>
        <p className="mt-1 max-w-prose text-sm text-neutral-600">
          A weighted blend of four real ratios computed from live tables. Weights are a documented
          judgement call, configurable post-POC. A ratio with no activity yet counts as compliant.
        </p>
        <Card className="mt-4 p-5">
          <div className="space-y-4">
            {audit.components.map((c) => {
              const pct = Math.round(c.value * 100);
              return (
                <div key={c.key}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-neutral-800">{c.label}</span>
                    <span className="tabular-nums text-neutral-600">
                      {pct}% · weight {c.weightPct}% · n={c.sampleSize}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
                    <div
                      className={`h-full rounded-full ${
                        pct >= 85
                          ? "bg-status-positive-500"
                          : pct >= 60
                            ? "bg-status-warning-500"
                            : "bg-status-error-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </section>

      {/* Risk alerts + exceptions */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900">Risk alerts &amp; exceptions</h2>
          <div className="flex gap-1">
            {(["all", "high", "medium", "low"] as SeverityFilter[]).map((s) => {
              const count = s === "all" ? audit.flagCounts.total : audit.flagCounts[s];
              const active = filter === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilter(s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                    active
                      ? "bg-neutral-900 text-white"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                  }`}
                >
                  {s} ({count})
                </button>
              );
            })}
          </div>
        </div>

        <Card className="mt-4 p-0">
          {filteredFlags.length === 0 ? (
            <p className="px-5 py-6 text-sm text-neutral-500">
              {audit.flags.length === 0
                ? "No risk flags fired against current data."
                : "No flags at this severity."}
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {filteredFlags.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                      <p className="text-sm font-medium text-neutral-900">{f.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-neutral-600">{f.detail}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">{f.consequence}</p>
                  </div>
                  {f.deepLink ? (
                    <a
                      href={f.deepLink}
                      className="shrink-0 self-center text-sm font-medium text-brand-600 hover:underline"
                    >
                      View
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {audit.flags.length === 0 && (
          <p className="mt-2 text-xs text-neutral-400">
            The market-benchmark budget rule is omitted until the benchmarks table lands (built by a
            concurrent workstream).
          </p>
        )}
      </section>

      {/* Per-stage SLA table */}
      <section className="mt-10">
        <h2 className="text-base font-semibold text-neutral-900">Per-stage SLA compliance</h2>
        <p className="mt-1 max-w-prose text-sm text-neutral-600">
          Real median turnaround vs a declared target for each governed stage. Targets are constants
          for the POC — configurable per tenant post-POC.
        </p>
        <Card className="mt-4 p-0">
          <TableShell className="border-0">
            <Thead>
              <Th>Stage</Th>
              <Th numeric>Target (h)</Th>
              <Th numeric>Median (h)</Th>
              <Th numeric>Within target</Th>
              <Th numeric>Sample</Th>
            </Thead>
            <Tbody>
              {audit.slaTable.map((r) => {
                const within =
                  r.withinTargetPct === null ? null : Math.round(r.withinTargetPct * 100);
                return (
                  <Tr key={r.key}>
                    <Td>
                      <span className="font-medium text-neutral-800">{r.label}</span>
                    </Td>
                    <Td numeric className="tabular-nums">
                      {r.targetHours}
                    </Td>
                    <Td numeric className="tabular-nums">
                      {r.medianHours ?? "—"}
                    </Td>
                    <Td numeric className="tabular-nums">
                      {within === null ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        <span
                          className={
                            within >= 85
                              ? "text-status-positive-700"
                              : within >= 60
                                ? "text-status-warning-700"
                                : "text-status-error-700"
                          }
                        >
                          {within}%
                        </span>
                      )}
                    </Td>
                    <Td numeric className="tabular-nums text-neutral-500">
                      {r.sampleSize}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </TableShell>
        </Card>
      </section>

      {/* Top drop-off reasons */}
      <section className="mt-10">
        <h2 className="text-base font-semibold text-neutral-900">Top drop-off reasons</h2>
        <p className="mt-1 max-w-prose text-sm text-neutral-600">
          Terminal-outcome tally across all applications.
        </p>
        <Card className="mt-4 p-0">
          {audit.dropOff.length === 0 ? (
            <p className="px-5 py-6 text-sm text-neutral-500">No terminal outcomes recorded yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {audit.dropOff.map((d) => (
                <li key={d.stage} className="flex items-center justify-between px-5 py-3">
                  <span className="text-sm text-neutral-800">{d.label}</span>
                  <span className="tabular-nums text-sm font-medium text-neutral-900">
                    {d.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
