import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { ChevronRightIcon } from "./icons";

/**
 * AlertCard (HRHEAD-01 shared pattern) — a tinted severity row: a soft red/
 * amber (or neutral) ground, a severity chip, an entity reference, a one-line
 * consequence, a date, and a chevron. Used in the HR-head risk rail this
 * ticket; later persona passes reuse it for their alert surfaces.
 *
 * Reuse contract:
 *   severity    — "critical" (red) | "warning" (amber) | "info" (neutral).
 *   chip        — short severity/label text for the pill.
 *   entity      — the entity reference (bold lead).
 *   consequence — one-line description of what it means.
 *   date        — optional right-aligned date/meta.
 *   href        — optional; whole row becomes a link with a chevron.
 */
export type AlertSeverity = "critical" | "warning" | "info";

const SEVERITY: Record<AlertSeverity, { ground: string; chip: string }> = {
  critical: {
    ground: "bg-status-error-50",
    chip: "bg-status-error-100 text-status-error-700",
  },
  warning: {
    ground: "bg-status-warning-50",
    chip: "bg-status-warning-100 text-status-warning-800",
  },
  info: {
    ground: "bg-neutral-50",
    chip: "bg-neutral-200 text-neutral-700",
  },
};

export interface AlertCardProps {
  severity: AlertSeverity;
  chip: ReactNode;
  entity?: ReactNode;
  consequence: ReactNode;
  date?: ReactNode;
  href?: string;
  className?: string;
}

export function AlertCard({
  severity,
  chip,
  entity,
  consequence,
  date,
  href,
  className,
}: AlertCardProps) {
  const s = SEVERITY[severity];
  const body = (
    <div className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5", s.ground, className)}>
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
          s.chip,
        )}
      >
        {chip}
      </span>
      <div className="min-w-0 flex-1">
        {entity ? <p className="truncate text-sm font-medium text-neutral-900">{entity}</p> : null}
        <p className="truncate text-xs text-neutral-600">{consequence}</p>
      </div>
      {date ? <span className="shrink-0 text-xs tabular-nums text-neutral-400">{date}</span> : null}
      {href ? <ChevronRightIcon className="shrink-0 text-neutral-400" /> : null}
    </div>
  );
  return href ? (
    <a href={href} className="block outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
      {body}
    </a>
  ) : (
    body
  );
}
