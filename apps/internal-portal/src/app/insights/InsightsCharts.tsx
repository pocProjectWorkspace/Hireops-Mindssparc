"use client";

import type { ReactNode } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
  Tooltip,
  type TooltipProps,
} from "recharts";
import type { GetRequisitionInsightsOutput } from "@hireops/api-types";
import { Card, EmptyState } from "@/components/ui";

/**
 * RO-03 — the /insights chart grid (client-only, code-split from
 * InsightsClient). Recharts panels for the hiring funnel, candidate score
 * distribution, skill-gap and panel-feedback trends; token-styled custom
 * panels for the salary-band comparison and the SLA & bottleneck tiles.
 *
 * Design discipline mirrors /metrics: one accent hue + neutrals + reserved
 * semantic tones (error for breaches / gaps), CSS-var colours so the tokens
 * (and any tenant brand override) resolve at render, an honest per-panel empty
 * state, and every axis labelled with a human unit.
 */

const BRAND = "var(--color-brand-600)";
const BRAND_SOFT = "var(--color-brand-400)";
const NEUTRAL_BAR = "var(--color-neutral-400)";
const ERROR = "var(--color-status-error-600)";
const WARNING = "var(--color-status-warning-500)";
const GRID = "var(--color-neutral-200)";
const AXIS = "var(--color-neutral-500)";
const INK = "var(--color-neutral-700)";

const TIER_FILL: Record<string, string> = {
  excellent: "var(--color-tier-platinum-fg)",
  good: "var(--color-tier-gold-fg)",
  partial: "var(--color-tier-silver-fg)",
  low: "var(--color-neutral-300)",
};

export function InsightsCharts({ data }: { data: GetRequisitionInsightsOutput }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <HiringFunnel funnel={data.funnel} />
      <ScoreDistribution scoreDistribution={data.scoreDistribution} />
      <SkillGap skillGap={data.skillGap} scope={data.scope} />
      <SalaryBand salaryBand={data.salaryBand} scope={data.scope} />
      <SlaTiles slaTiles={data.slaTiles} bottleneckNote={data.bottleneckNote} />
      <PanelTrends trends={data.panelFeedbackTrends} />
    </div>
  );
}

function Panel({
  title,
  subtitle,
  empty,
  emptyTitle,
  emptyHint,
  children,
  wide,
}: {
  title: string;
  subtitle: string;
  empty: boolean;
  emptyTitle: string;
  emptyHint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Card className={wide ? "flex flex-col lg:col-span-2" : "flex flex-col"}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        <p className="text-xs text-neutral-500">{subtitle}</p>
      </div>
      {empty ? (
        <div className="flex min-h-[200px] items-center justify-center">
          <EmptyState title={emptyTitle} hint={emptyHint} />
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  format,
}: TooltipProps<number, string> & { format: (value: number, name: string) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-neutral-200 bg-white px-3 py-2 shadow-2">
      {label ? <p className="mb-0.5 text-xs font-medium text-neutral-900">{label}</p> : null}
      {payload.map((p, i) => (
        <p key={i} className="text-xs text-neutral-600">
          {format(typeof p.value === "number" ? p.value : Number(p.value), p.name ?? "")}
        </p>
      ))}
    </div>
  );
}

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ─────────────── 1. hiring funnel ───────────────

function HiringFunnel({ funnel }: { funnel: GetRequisitionInsightsOutput["funnel"] }) {
  const rows = funnel.map((f) => ({
    label: humanize(f.stage),
    value: f.count,
    dropOff: f.dropOffPct,
  }));
  const empty = funnel.every((f) => f.count === 0);
  return (
    <Panel
      title="Hiring funnel"
      subtitle="Candidates by current stage, with drop-off"
      empty={empty}
      emptyTitle="No candidates in the pipeline yet"
    >
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 16, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            label={{
              value: "candidates",
              position: "insideBottom",
              offset: -6,
              fontSize: 11,
              fill: AXIS,
            }}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={120}
            tick={{ fontSize: 11, fill: INK }}
            stroke={AXIS}
          />
          <Tooltip
            cursor={{ fill: "var(--color-neutral-100)" }}
            content={
              <ChartTooltip
                format={(v, name) => {
                  const row = rows.find((r) => r.value === v && name === "value");
                  const drop = row && row.dropOff != null ? ` · ${row.dropOff}% drop-off` : "";
                  return `${v.toLocaleString()} candidates${drop}`;
                }}
              />
            }
          />
          <Bar dataKey="value" fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ─────────────── 2. score distribution ───────────────

function ScoreDistribution({
  scoreDistribution,
}: {
  scoreDistribution: GetRequisitionInsightsOutput["scoreDistribution"];
}) {
  const rows = scoreDistribution.map((b) => ({
    label: b.label,
    range: b.range,
    value: b.count,
    key: b.key,
  }));
  const empty = scoreDistribution.every((b) => b.count === 0);
  return (
    <Panel
      title="Candidate score distribution"
      subtitle="AI screening scores, bucketed"
      empty={empty}
      emptyTitle="No scored candidates yet"
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} stroke={AXIS} />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            width={40}
            label={{
              value: "candidates",
              angle: -90,
              position: "insideLeft",
              fontSize: 11,
              fill: AXIS,
            }}
          />
          <Tooltip
            cursor={{ fill: "var(--color-neutral-100)" }}
            content={<ChartTooltip format={(v) => `${v.toLocaleString()} candidates`} />}
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={64}>
            {rows.map((r) => (
              <Cell key={r.key} fill={TIER_FILL[r.key] ?? TIER_FILL.low} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-500">
        {scoreDistribution.map((b) => (
          <span key={b.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: TIER_FILL[b.key] }}
            />
            {b.label} <span className="tabular-nums text-neutral-400">{b.range}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}

// ─────────────── 3. skill gap ───────────────

function SkillGap({
  skillGap,
  scope,
}: {
  skillGap: GetRequisitionInsightsOutput["skillGap"];
  scope: "single" | "all";
}) {
  const rows = skillGap.map((s) => ({
    label: s.skillName,
    value: s.gapPct,
    required: s.isRequired,
    missing: s.candidatesMissing,
    total: s.totalCandidates,
  }));
  return (
    <Panel
      title="Skill gap analysis"
      subtitle="% of candidates missing each JD skill · must-haves accented"
      empty={rows.length === 0}
      emptyTitle={
        scope === "all" ? "Pick a requisition to see its skill gaps" : "No JD skills to compare"
      }
      emptyHint={scope === "all" ? "A skill gap compares candidates against one JD." : undefined}
    >
      <ResponsiveContainer width="100%" height={Math.max(200, rows.length * 34 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 32, bottom: 16, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            unit="%"
            label={{
              value: "candidates missing (%)",
              position: "insideBottom",
              offset: -6,
              fontSize: 11,
              fill: AXIS,
            }}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={130}
            tick={{ fontSize: 11, fill: INK }}
            stroke={AXIS}
          />
          <Tooltip
            cursor={{ fill: "var(--color-neutral-100)" }}
            content={
              <ChartTooltip
                format={(v, name) => {
                  const r = rows.find((x) => x.value === v && name === "value");
                  const detail = r ? ` (${r.missing}/${r.total} candidates)` : "";
                  return `${v}% missing${detail}`;
                }}
              />
            }
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={20}>
            {rows.map((r, i) => (
              <Cell key={i} fill={r.required ? ERROR : NEUTRAL_BAR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-1 text-[11px] text-neutral-400">
        <span
          className="mr-1 inline-block h-2 w-2 rounded-sm align-middle"
          style={{ backgroundColor: ERROR }}
        />
        Must-have skill
      </p>
    </Panel>
  );
}

// ─────────────── 4. salary band vs curated benchmark ───────────────

function formatInr(v: number): string {
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

function SalaryBand({
  salaryBand,
  scope,
}: {
  salaryBand: GetRequisitionInsightsOutput["salaryBand"];
  scope: "single" | "all";
}) {
  const hasBudget = salaryBand && (salaryBand.budgetMin != null || salaryBand.budgetMax != null);
  const empty = !salaryBand || (!hasBudget && salaryBand.benchmarkMedian == null);
  const bars: { label: string; value: number; fill: string }[] = [];
  if (salaryBand) {
    if (salaryBand.budgetMin != null)
      bars.push({ label: "Budget floor", value: salaryBand.budgetMin, fill: BRAND_SOFT });
    if (salaryBand.budgetMax != null)
      bars.push({ label: "Budget ceiling", value: salaryBand.budgetMax, fill: BRAND });
    if (salaryBand.benchmarkMedian != null)
      bars.push({ label: "Benchmark median", value: salaryBand.benchmarkMedian, fill: WARNING });
  }
  const max = bars.reduce((m, b) => Math.max(m, b.value), 0) * 1.08 || 1;
  return (
    <Panel
      title="Salary band comparison"
      subtitle="Your budget vs the curated benchmark median"
      empty={empty}
      emptyTitle={
        scope === "all" ? "Pick a requisition to compare its band" : "No budget or benchmark set"
      }
      emptyHint={
        scope === "all"
          ? undefined
          : "Set a comp band on the requisition, or add a curated benchmark."
      }
    >
      <div className="space-y-3 py-2">
        {bars.map((b) => (
          <div key={b.label}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-neutral-600">{b.label}</span>
              <span className="tabular-nums font-medium text-neutral-800">
                {formatInr(b.value)}
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-100">
              <div
                className="h-full rounded-full"
                style={{ width: `${(b.value / max) * 100}%`, backgroundColor: b.fill }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-neutral-400">
        Curated benchmarks
        {salaryBand?.benchmarkTtfDays != null
          ? ` · benchmark time-to-fill ${salaryBand.benchmarkTtfDays}d`
          : ""}
        {salaryBand?.sourceNote ? ` · ${salaryBand.sourceNote}` : ""}
      </p>
    </Panel>
  );
}

// ─────────────── 5. SLA & bottleneck tiles ───────────────

function SlaTiles({
  slaTiles,
  bottleneckNote,
}: {
  slaTiles: GetRequisitionInsightsOutput["slaTiles"];
  bottleneckNote: string | null;
}) {
  const active = slaTiles.filter((t) => t.count > 0);
  const empty = active.length === 0;
  return (
    <Panel
      title="SLA & bottlenecks"
      subtitle="Average time in each active stage vs its SLA target"
      empty={empty}
      emptyTitle="No candidates in SLA-tracked stages"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {active.map((t) => (
          <div
            key={t.stage}
            className={`rounded-lg border p-2.5 ${
              t.breach
                ? "border-status-error-200 bg-status-error-50"
                : "border-neutral-200 bg-white"
            }`}
          >
            <p className="truncate text-[11px] font-medium text-neutral-600">{humanize(t.stage)}</p>
            <p
              className={`mt-1 text-lg font-semibold tabular-nums leading-none ${
                t.breach ? "text-status-error-700" : "text-neutral-900"
              }`}
            >
              {t.avgAgeHours == null ? "—" : `${t.avgAgeHours}h`}
            </p>
            <p className="mt-1 text-[11px] text-neutral-400">
              target {t.targetHours}h · {t.count} in stage
            </p>
          </div>
        ))}
      </div>
      {bottleneckNote ? (
        <p className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          {bottleneckNote}
        </p>
      ) : null}
    </Panel>
  );
}

// ─────────────── 6. panel feedback trends ───────────────

function PanelTrends({ trends }: { trends: GetRequisitionInsightsOutput["panelFeedbackTrends"] }) {
  return (
    <Panel
      title="Panel feedback trends"
      subtitle="Per completed round · submitted scorecards only (aggregates, no names)"
      empty={trends.length === 0}
      emptyTitle="No completed rounds with submitted feedback yet"
    >
      <ul className="space-y-3 py-1">
        {trends.map((t) => (
          <li
            key={`${t.roundNumber}-${t.roundName}`}
            className="rounded-lg border border-neutral-200 p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-neutral-900">
                Round {t.roundNumber} · {t.roundName}
              </span>
              <span className="text-[11px] text-neutral-400">
                {t.submittedCount} scorecard{t.submittedCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="mb-1 text-neutral-500">Avg score</p>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${t.avgScore != null ? (t.avgScore / 5) * 100 : 0}%`,
                        backgroundColor: BRAND,
                      }}
                    />
                  </div>
                  <span className="tabular-nums font-medium text-neutral-800">
                    {t.avgScore == null ? "—" : `${t.avgScore}/5`}
                  </span>
                </div>
              </div>
              <div>
                <p className="mb-1 text-neutral-500">Pass rate</p>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${t.passRate ?? 0}%`,
                        backgroundColor: "var(--color-status-positive-600)",
                      }}
                    />
                  </div>
                  <span className="tabular-nums font-medium text-neutral-800">
                    {t.passRate == null ? "—" : `${t.passRate}%`}
                  </span>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
