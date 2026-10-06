"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { AskDataResult } from "@hireops/api-types";

/**
 * ASK-DATA — the bar / line visual for an answer. Client-only (loaded via
 * next/dynamic ssr:false from AskDataClient), the same recharts + DESIGN-05
 * token discipline as /metrics' ChartGrid: one accent hue + neutrals, colours
 * as CSS var() references so a tenant brand override applies at render time.
 * The plotted values are exactly the result's rows — nothing is derived here.
 */

const SERIES_COLORS = [
  "var(--color-brand-600)",
  "var(--color-brand-300)",
  "var(--color-neutral-500)",
];
const GRID = "var(--color-neutral-200)";
const AXIS = "var(--color-neutral-500)";
const INK = "var(--color-neutral-700)";

export function AskDataChart({ result }: { result: AskDataResult }) {
  const chart = result.chart;
  if (!chart) return null;
  const labelFor = (key: string) => result.columns.find((c) => c.key === key)?.label ?? key;
  const data = result.rows;
  const multi = chart.y.length > 1;

  if (result.kind === "line") {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey={chart.x} tick={{ fontSize: 11, fill: INK }} stroke={AXIS} />
          <YAxis tick={{ fontSize: 11, fill: AXIS }} stroke={AXIS} allowDecimals />
          <Tooltip />
          {chart.y.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              name={labelFor(key)}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls={false}
            />
          ))}
          {multi ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Horizontal bars: category labels (stages, units, names) read better on the Y axis.
  const height = Math.max(200, data.length * (multi ? 36 : 28) + 48);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={{ fontSize: 11, fill: AXIS }} stroke={AXIS} />
        <YAxis
          type="category"
          dataKey={chart.x}
          width={150}
          tick={{ fontSize: 11, fill: INK }}
          stroke={AXIS}
        />
        <Tooltip cursor={{ fill: "var(--color-neutral-100)" }} />
        {chart.y.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            name={labelFor(key)}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
          />
        ))}
        {multi ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
      </BarChart>
    </ResponsiveContainer>
  );
}
