import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * DataBar — the single horizontal-bar language shared by the admin dashboards
 * (costs' 14-day spend, reports' pipeline funnel). A labelled row: a fixed
 * label slot, a brand-filled track sized 0–100%, optional middle meta, and a
 * right-aligned value. Brand fill on a quiet neutral track — the figure is the
 * load-bearing element, the bar a proportional reference. DESIGN-03 added this
 * so both dashboards read as one product rather than two hand-rolled bar lists.
 */
export interface DataBarProps {
  label: ReactNode;
  value: ReactNode;
  /** 0–100 fill percentage of the track. */
  pct: number;
  /** Optional content between the bar and the value (e.g. a call count). */
  meta?: ReactNode;
  /** Render the label in the mono face (dates, keys). */
  monoLabel?: boolean;
  /** Override the label slot width/colour (defaults to a 40-unit neutral slot). */
  labelClassName?: string;
  className?: string;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

export function DataBar({
  label,
  value,
  pct,
  meta,
  monoLabel = false,
  labelClassName,
  className,
}: DataBarProps) {
  const width = clamp(pct);
  return (
    <div className={cn("flex items-center gap-3 text-xs", className)}>
      <span
        className={cn(
          "shrink-0 truncate",
          monoLabel && "font-mono",
          labelClassName ?? "w-40 text-neutral-600",
        )}
      >
        {label}
      </span>
      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
        <span
          className="block h-full rounded-full bg-brand-500 transition-[width] duration-300"
          style={{ width: `${width}%` }}
          aria-hidden
        />
      </span>
      {meta !== undefined ? (
        <span className="w-16 shrink-0 text-right tabular-nums text-neutral-500">{meta}</span>
      ) : null}
      <span className="w-20 shrink-0 text-right font-medium tabular-nums text-neutral-800">
        {value}
      </span>
    </div>
  );
}
