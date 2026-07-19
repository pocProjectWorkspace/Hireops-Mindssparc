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
  type TooltipProps,
} from "recharts";
import type { GetHrAnalyticsOutput } from "@hireops/api-types";
import { Card, EmptyState } from "@/components/ui";

/**
 * HROPS-02 — the recharts grid for /hr-analytics. Client-only (loaded via
 * next/dynamic ssr:false), five panels over getHrAnalytics: time-to-hire by
 * department, candidate drop-off by stage, offer acceptance donut, hiring demand
 * by department (open vs filled), average offer vs band midpoint by role.
 *
 * DESIGN-05 tokens only — one accent hue (brand) + neutrals + reserved semantic
 * tones. Every axis labelled with a human unit; every mark has a tooltip; each
 * panel has an honest empty state. Colours are CSS var() references so they
 * track the token system at render time.
 */

const BRAND = "var(--color-brand-600)";
const BRAND_SOFT = "var(--color-brand-400)";
const NEUTRAL_BAR = "var(--color-neutral-400)";
const POSITIVE = "var(--color-status-positive-600)";
const WARNING = "var(--color-status-warning-500)";
const ERROR = "var(--color-status-error-600)";
const GRID = "var(--color-neutral-200)";
const AXIS = "var(--color-neutral-500)";
const INK = "var(--color-neutral-700)";

export function AnalyticsCharts({ data }: { data: GetHrAnalyticsOutput }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <TimeToHire rows={data.timeToHireByDept} />
      <DropOff rows={data.dropOffByStage} />
      <OfferAcceptance data={data.offerAcceptance} />
      <Demand rows={data.demandByDept} />
      <OfferVsBand rows={data.offerVsBandByRole} />
    </div>
  );
}

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

// 1. Time-to-hire by department
function TimeToHire({ rows }: { rows: GetHrAnalyticsOutput["timeToHireByDept"] }) {
  const data = rows.map((r) => ({
    label: r.department,
    value: r.avgDays ?? 0,
    has: r.avgDays != null,
  }));
  const empty = rows.length === 0 || rows.every((r) => r.avgDays == null);
  return (
    <Panel
      title="Time to hire by department"
      subtitle="Avg days: application → offer accepted"
      empty={empty}
      emptyTitle="No completed hires yet"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 16, left: 8 }}>
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
            content={<ChartTooltip format={(v) => `${v.toLocaleString()} days avg`} />}
          />
          <Bar dataKey="value" fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// 2. Candidate drop-off by stage
function DropOff({ rows }: { rows: GetHrAnalyticsOutput["dropOffByStage"] }) {
  const data = rows.map((r) => ({ label: humanize(r.stage), value: r.count }));
  const empty = rows.every((r) => r.count === 0);
  return (
    <Panel
      title="Candidate drop-off by stage"
      subtitle="Applications currently at each stage"
      empty={empty}
      emptyTitle="No applications yet"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 16, left: 8 }}>
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
            content={<ChartTooltip format={(v) => `${v.toLocaleString()} candidates`} />}
          />
          <Bar dataKey="value" fill={NEUTRAL_BAR} radius={[0, 4, 4, 0]} maxBarSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

// 3. Offer acceptance donut
function OfferAcceptance({ data }: { data: GetHrAnalyticsOutput["offerAcceptance"] }) {
  const rows = [
    { label: "Accepted", key: "accepted", value: data.accepted, fill: POSITIVE },
    { label: "Declined", key: "declined", value: data.declined, fill: ERROR },
    { label: "Pending", key: "pending", value: data.pending, fill: WARNING },
  ];
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <Panel
      title="Offer acceptance"
      subtitle="Accepted / declined / pending offers"
      empty={total === 0}
      emptyTitle="No offers yet"
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
                  <Cell key={r.key} fill={r.fill} />
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
            <span className="text-lg font-semibold text-neutral-900">{total}</span>
            <span className="text-[11px] text-neutral-500">offers</span>
          </div>
        </div>
        <ul className="flex-1 space-y-1.5 text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: r.fill }}
              />
              <span className="text-neutral-700">{r.label}</span>
              <span className="ml-auto tabular-nums text-neutral-500">
                {r.value} · {total > 0 ? ((r.value / total) * 100).toFixed(0) : 0}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

// 4. Hiring demand by department (open vs filled)
function Demand({ rows }: { rows: GetHrAnalyticsOutput["demandByDept"] }) {
  const data = rows.map((r) => ({ label: r.department, open: r.open, filled: r.filled }));
  const empty = rows.length === 0 || rows.every((r) => r.open === 0 && r.filled === 0);
  return (
    <Panel
      title="Hiring demand by department"
      subtitle="Open vs filled requisitions"
      empty={empty}
      emptyTitle="No requisitions yet"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} stroke={AXIS} />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            label={{ value: "reqs", angle: -90, position: "insideLeft", fontSize: 11, fill: AXIS }}
          />
          <Tooltip
            cursor={{ fill: "var(--color-neutral-100)" }}
            content={<ChartTooltip format={(v, name) => `${name}: ${v.toLocaleString()}`} />}
          />
          <Bar dataKey="open" name="Open" fill={BRAND} radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Bar
            dataKey="filled"
            name="Filled"
            fill={BRAND_SOFT}
            radius={[3, 3, 0, 0]}
            maxBarSize={28}
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-neutral-500">
        <Legend color={BRAND} label="Open" />
        <Legend color={BRAND_SOFT} label="Filled" />
      </div>
    </Panel>
  );
}

// 5. Average offer vs band midpoint by role
function OfferVsBand({ rows }: { rows: GetHrAnalyticsOutput["offerVsBandByRole"] }) {
  const data = rows.map((r) => ({
    label: r.role,
    offer: r.avgOfferPaise != null ? r.avgOfferPaise / 100 / 100_000 : 0,
    band: r.bandMidPaise != null ? r.bandMidPaise / 100 / 100_000 : 0,
  }));
  const empty = rows.length === 0;
  return (
    <Panel
      title="Average offer vs band midpoint"
      subtitle="By role · ₹ LPA"
      empty={empty}
      emptyTitle="No offers yet"
    >
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: INK }} stroke={AXIS} interval={0} />
          <YAxis
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={AXIS}
            width={48}
            tickFormatter={(v: number) => `₹${v.toFixed(0)}L`}
            label={{ value: "LPA", angle: -90, position: "insideLeft", fontSize: 11, fill: AXIS }}
          />
          <Tooltip
            cursor={{ fill: "var(--color-neutral-100)" }}
            content={<ChartTooltip format={(v, name) => `${name}: ₹${v.toFixed(1)} LPA`} />}
          />
          <Bar
            dataKey="offer"
            name="Avg offer"
            fill={BRAND}
            radius={[3, 3, 0, 0]}
            maxBarSize={28}
          />
          <Bar
            dataKey="band"
            name="Band mid"
            fill={NEUTRAL_BAR}
            radius={[3, 3, 0, 0]}
            maxBarSize={28}
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-neutral-500">
        <Legend color={BRAND} label="Avg offer" />
        <Legend color={NEUTRAL_BAR} label="Band mid" />
      </div>
    </Panel>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
