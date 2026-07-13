import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * StatTile — the single KPI tile. Label (small caps), value (large, tabular),
 * optional hint below. `tone` tints the surface for the one figure worth
 * drawing the eye to (accent) or a status read (warning/error/…); default is
 * a flat bordered card.
 *
 * API matches the ad-hoc `Tile` components on /admin/costs and /admin/reports
 * so those can be swept onto it in phase 3 without call-site churn.
 */
export type StatTileTone = "neutral" | "accent" | "positive" | "warning" | "error" | "info";

const TONES: Record<StatTileTone, string> = {
  neutral: "border-neutral-200 bg-white text-neutral-900",
  accent: "border-brand-100 bg-brand-50 text-brand-800",
  positive: "border-status-positive-200 bg-status-positive-50 text-status-positive-800",
  warning: "border-status-warning-200 bg-status-warning-50 text-status-warning-800",
  error: "border-status-error-200 bg-status-error-50 text-status-error-800",
  info: "border-status-info-200 bg-status-info-50 text-status-info-800",
};

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTileTone;
  className?: string;
}

export function StatTile({ label, value, hint, tone = "neutral", className }: StatTileProps) {
  return (
    <div className={cn("rounded-md border p-4", TONES[tone], className)}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs opacity-60">{hint}</p> : null}
    </div>
  );
}
