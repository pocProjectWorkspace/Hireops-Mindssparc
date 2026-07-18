import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { ArrowDownIcon, ArrowUpIcon } from "./icons";
import type { HrHeadKpiDelta } from "@hireops/api-types";

/**
 * HeroStatCard (HRHEAD-01 shared pattern) — the single accent-FILLED stat card
 * for the most-urgent KPI. Indigo (brand) ground, white text, an icon chip
 * top-right, and an optional delta line under the number (green/red arrow with
 * a "vs last month"-style caption). Siblings on the strip stay white
 * (use StatTile).
 *
 * Reuse contract:
 *   label   — small-caps KPI label.
 *   value   — the big figure (pre-formatted string/number).
 *   caption — optional sub-line under the value (a secondary figure).
 *   delta   — optional {label, direction, tone, caption}; tone drives colour,
 *             direction drives the arrow (flat → no arrow).
 *   icon    — the top-right chip glyph.
 *   href    — optional; wraps the card in a link.
 */
export interface HeroStatCardProps {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  delta?: HrHeadKpiDelta | null;
  icon?: ReactNode;
  href?: string;
  className?: string;
}

const DELTA_TONE: Record<HrHeadKpiDelta["tone"], string> = {
  good: "text-status-positive-100",
  bad: "text-status-error-100",
  neutral: "text-white/70",
};

export function HeroStatCard({
  label,
  value,
  caption,
  delta,
  icon,
  href,
  className,
}: HeroStatCardProps) {
  const inner = (
    <div
      className={cn(
        "relative flex h-full flex-col rounded-card bg-brand-600 p-4 text-white shadow-card",
        "bg-gradient-to-br from-brand-600 to-brand-700",
        href && "transition-colors hover:from-brand-500 hover:to-brand-700",
        className,
      )}
    >
      {icon ? (
        <span className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white">
          {icon}
        </span>
      ) : null}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">{label}</p>
      <p className="mt-2 text-[2rem] font-semibold leading-none tabular-nums tracking-tight">
        {value}
      </p>
      {delta ? (
        <p
          className={cn("mt-2 flex items-center gap-1 text-xs font-medium", DELTA_TONE[delta.tone])}
        >
          {delta.direction === "down" ? (
            <ArrowDownIcon width={13} height={13} />
          ) : delta.direction === "up" ? (
            <ArrowUpIcon width={13} height={13} />
          ) : null}
          <span>{delta.label}</span>
          <span className="text-white/60">· {delta.caption}</span>
        </p>
      ) : caption ? (
        <p className="mt-2 text-xs text-white/70">{caption}</p>
      ) : null}
      {delta && caption ? <p className="mt-1 text-xs text-white/60">{caption}</p> : null}
    </div>
  );
  return href ? (
    <a
      href={href}
      className="rounded-card outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      {inner}
    </a>
  ) : (
    inner
  );
}
