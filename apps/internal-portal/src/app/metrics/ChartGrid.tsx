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
  PieChart,
  Pie,
  AreaChart,
  Area,
  type TooltipProps,
} from "recharts";
import type { GetHrMetricsOutput } from "@hireops/api-types";
import { Card, EmptyState } from "@/components/ui";

/**
 * METRICS-01 — the recharts chart grid for /metrics. Client-only (loaded via
 * next/dynamic ssr:false from MetricsClient), rendering the six panels over
 * the getHrMetrics aggregate: pipeline funnel, time in stage, source mix,
 * offer funnel, AI spend, score distribution.
 *
 * Design discipline (DESIGN-05 tokens only): one accent hue (brand) + neutrals
 * + reserved semantic tones (positive/error on the offer funnel) + the tier
 * metallics on the score histogram. No gradient fills, no 3D. Every axis is
 * labeled with a human unit; every mark has a tooltip; each panel has an
 * honest per-chart empty state. Colours are CSS var() references so they track
 * the token system (and any per-tenant brand override) at render time.
 */

// ── token references (resolve in the browser) ──
const BRAND = "var(--color-brand-600)";
const BRAND_SOFT = "var(--color-brand-400)";
const NEUTRAL_BAR = "var(--color-neutral-400)";
const POSITIVE = "var(--color-status-positive-600)";
const ERROR = "var(--color-status-error-600)";
const GRID = "var(--color-neutral-200)";
const AXIS = "var(--color-neutral-500)";
const INK = "var(--color-neutral-700)";

// Score-tier metallics (DESIGN-05). Neutral for the sub-tier bands.
const TIER_FILL: Record<string, string> = {
  platinum: "var(--color-tier-platinum-fg)",
  gold: "var(--color-tier-gold-fg)",
  silver: "var(--color-tier-silver-fg)",
  neutral: "var(--color-neutral-300)",
};

// Source palette — a fixed per-source tint from the brand + neutral ramps
// (monochrome family; colour follows the entity, never its rank). Identity is
// carried by the legend, never colour alone. partner_empanelled takes the
// darkest brand step so its share reads as the emphasised slice.
const SOURCE_COLORS: Record<string, string> = {
  career_site: "var(--color-brand-600)",
  referral: "var(--color-brand-400)",
  partner_empanelled: "var(--color-brand-800)",
  partner_adhoc: "var(--color-brand-300)",
  job_board: "var(--color-neutral-500)",
  agency_search: "var(--color-neutral-400)",
  talent_pool: "var(--color-neutral-300)",
  whatsapp: "var(--color-neutral-600)",
};
const SOURCE_FALLBACK = "var(--color-neutral-400)";

export function ChartGrid({ data }: { data: GetHrMetricsOutput }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <PipelineFunnel funnel={data.funnel} />
      <TimeInStage timeInStage={data.timeInStage} />
      <SourceMix sourceMix={data.sourceMix} />
      <OfferFunnel offerFunnel={data.offerFunnel} />
      <AiSpend aiSpend={data.aiSpend} />
      <ScoreDistribution scoreDistribution={data.scoreDistribution} />
    </div>
  );
}

// ─────────────────────────────── panel shell ───────────────────────────────

function Panel({
  title,
  subtitle,
  empty,
  emptyTitle,
  children,
}: {
  title: string;
  subtitle: string;
  empty: boolean;
  emptyTitle: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        <p className="text-xs text-neutral-500">{subtitle}</p>
      </div>
      {empty ? (
        <div className="flex min-h-[220px] items-center justify-center">
          <EmptyState title={emptyTitle} />
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

// ─────────────────────────────── tooltip ───────────────────────────────

/** Shared tooltip — token-styled surface; the caller supplies the label + a
 * formatted value string. Text wears ink tokens, never the mark colour. */
function ChartTooltip({
  active,
  payload,
  label,
  format,
}: TooltipProps<number, string> & {
  format: (value: number, name: string) => string;
}) {
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

// ─────────────────────────────── 1. pipeline funnel ───────────────────────────────

function PipelineFunnel({ funnel }: { funnel: GetHrMetricsOutput["funnel"] }) {
  const rows = funnel.map((f) => ({ label: humanize(f.stage), value: f.count }));
  const empty = funnel.every((f) => f.count === 0);
  return (
    <Panel
      title="Pipeline funnel"
      subtitle="Applications by current stage · all time"
      empty={empty}
      emptyTitle="No applications in the pipeline yet"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 16, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            label={{
              value: "applications",
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
            content={<ChartTooltip format={(v) => `${v.toLocaleString()} applications`} />}
          />
          <Bar dataKey="value" fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ─────────────────────────────── 2. time in stage ───────────────────────────────

function TimeInStage({ timeInStage }: { timeInStage: GetHrMetricsOutput["timeInStage"] }) {
  const rows = timeInStage.map((s) => ({
    label: humanize(s.stage),
    value: s.avg_days ?? 0,
    hasData: s.avg_days !== null,
  }));
  const empty = timeInStage.every((s) => s.avg_days === null);
  return (
    <Panel
      title="Time in stage"
      subtitle="Average days before moving on · all time"
      empty={empty}
      emptyTitle="No completed stage transitions yet"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 16, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            label={{
              value: "days",
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
                format={(v) => (v > 0 ? `${v.toLocaleString()} days avg` : "no completed visits")}
              />
            }
          />
          <Bar dataKey="value" fill={NEUTRAL_BAR} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ─────────────────────────────── 3. source mix (donut) ───────────────────────────────

function SourceMix({ sourceMix }: { sourceMix: GetHrMetricsOutput["sourceMix"] }) {
  const total = sourceMix.reduce((s, r) => s + r.applications, 0);
  const rows = sourceMix.map((r) => ({
    label: humanize(r.source),
    source: r.source,
    value: r.applications,
  }));
  return (
    <Panel
      title="Source mix"
      subtitle="Applications by channel · all time"
      empty={sourceMix.length === 0}
      emptyTitle="No sourced applications yet"
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="relative h-[220px] w-[220px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                dataKey="value"
                nameKey="label"
                innerRadius={58}
                outerRadius={88}
                paddingAngle={2}
                stroke="var(--color-neutral-50)"
                strokeWidth={2}
              >
                {rows.map((r) => (
                  <Cell key={r.source} fill={SOURCE_COLORS[r.source] ?? SOURCE_FALLBACK} />
                ))}
              </Pie>
              <Tooltip
                content={
                  <ChartTooltip
                    format={(v, name) =>
                      `${name}: ${v.toLocaleString()} (${total > 0 ? ((v / total) * 100).toFixed(0) : 0}%)`
                    }
                  />
                }
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-lg font-semibold text-neutral-900">{total.toLocaleString()}</span>
            <span className="text-[11px] text-neutral-500">total</span>
          </div>
        </div>
        <ul className="flex-1 space-y-1.5 text-sm">
          {rows.map((r) => {
            const pct = total > 0 ? (r.value / total) * 100 : 0;
            const emphasised = r.source === "partner_empanelled";
            return (
              <li key={r.source} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: SOURCE_COLORS[r.source] ?? SOURCE_FALLBACK }}
                />
                <span className={emphasised ? "font-medium text-neutral-900" : "text-neutral-700"}>
                  {r.label}
                </span>
                <span className="ml-auto tabular-nums text-neutral-500">
                  {r.value.toLocaleString()} · {pct.toFixed(0)}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

// ─────────────────────────────── 4. offer funnel ───────────────────────────────

function OfferFunnel({ offerFunnel }: { offerFunnel: GetHrMetricsOutput["offerFunnel"] }) {
  const rows = [
    { label: "Extended", value: offerFunnel.extended, fill: BRAND_SOFT },
    { label: "Accepted", value: offerFunnel.accepted, fill: POSITIVE },
    { label: "Declined", value: offerFunnel.declined, fill: ERROR },
  ];
  const empty =
    offerFunnel.extended === 0 && offerFunnel.accepted === 0 && offerFunnel.declined === 0;
  return (
    <Panel
      title="Offer funnel"
      subtitle="Extended → accepted / declined · all time"
      empty={empty}
      emptyTitle="No offers yet this period"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: INK }} stroke={AXIS} />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            label={{
              value: "offers",
              angle: -90,
              position: "insideLeft",
              fontSize: 11,
              fill: AXIS,
            }}
          />
          <Tooltip
            cursor={{ fill: "var(--color-neutral-100)" }}
            content={<ChartTooltip format={(v) => `${v.toLocaleString()} offers`} />}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64}>
            {rows.map((r) => (
              <Cell key={r.label} fill={r.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ─────────────────────────────── 5. AI spend ───────────────────────────────

function AiSpend({ aiSpend }: { aiSpend: GetHrMetricsOutput["aiSpend"] }) {
  const rows = aiSpend.map((d) => ({
    day: d.day.slice(5), // MM-DD
    usd: Number(d.cost_micros) / 1_000_000,
    calls: d.calls,
  }));
  return (
    <Panel
      title="AI spend"
      subtitle="Daily Anthropic cost, USD · last 14 days"
      empty={aiSpend.length === 0}
      emptyTitle="No AI usage in the last 14 days"
    >
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: AXIS }} stroke={AXIS} minTickGap={16} />
          <YAxis
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            width={56}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            label={{ value: "USD", angle: -90, position: "insideLeft", fontSize: 11, fill: AXIS }}
          />
          <Tooltip
            cursor={{ stroke: AXIS, strokeWidth: 1 }}
            content={<ChartTooltip format={(v) => `$${v.toFixed(4)}`} />}
          />
          <Area
            type="monotone"
            dataKey="usd"
            stroke={BRAND}
            strokeWidth={2}
            fill={BRAND}
            fillOpacity={0.12}
            dot={{ r: 2, fill: BRAND, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// ─────────────────────────────── 6. score distribution ───────────────────────────────

function ScoreDistribution({
  scoreDistribution,
}: {
  scoreDistribution: GetHrMetricsOutput["scoreDistribution"];
}) {
  const rows = scoreDistribution.map((b) => ({
    label: b.label,
    value: b.count,
    tier: b.tier,
  }));
  const empty = scoreDistribution.every((b) => b.count === 0);
  const tierLegend: { tier: string; label: string; range: string }[] = [
    { tier: "silver", label: "Silver", range: "50–69" },
    { tier: "gold", label: "Gold", range: "70–89" },
    { tier: "platinum", label: "Platinum", range: "90–100" },
  ];
  return (
    <Panel
      title="Score distribution"
      subtitle="AI score histogram, tier-banded · all time"
      empty={empty}
      emptyTitle="No scored candidates yet"
    >
      <ResponsiveContainer width="100%" height={244}>
        <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: AXIS }}
            stroke={AXIS}
            interval={0}
            label={{
              value: "AI score",
              position: "insideBottom",
              offset: -6,
              fontSize: 11,
              fill: AXIS,
            }}
          />
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
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {rows.map((r) => (
              <Cell key={r.label} fill={TIER_FILL[r.tier] ?? TIER_FILL.neutral} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-500">
        {tierLegend.map((t) => (
          <span key={t.tier} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: TIER_FILL[t.tier] }}
            />
            {t.label} <span className="tabular-nums text-neutral-400">{t.range}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}

// ─────────────────────────────── helpers ───────────────────────────────

/** snake_case enum label → "Sentence case" for display. */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
