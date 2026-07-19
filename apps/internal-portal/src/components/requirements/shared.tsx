import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import type { ReqHealthWire, ReqDifficultyWire } from "@hireops/api-types";

/**
 * Requirement-owner shared UI bits (RO-01). Health bars + difficulty chips read
 * the deterministic rule-engine output (health score 0–100 + components,
 * difficulty low|medium|high). Colour is a status read, not decoration:
 * green ≥75, amber 50–74, red <50 for health; green/amber/red for difficulty.
 */

export function healthTone(score: number): "positive" | "warning" | "error" {
  if (score >= 75) return "positive";
  if (score >= 50) return "warning";
  return "error";
}

const HEALTH_FILL: Record<"positive" | "warning" | "error", string> = {
  positive: "bg-status-positive-500",
  warning: "bg-status-warning-500",
  error: "bg-status-error-500",
};

const HEALTH_TEXT: Record<"positive" | "warning" | "error", string> = {
  positive: "text-status-positive-700",
  warning: "text-status-warning-800",
  error: "text-status-error-700",
};

/** Inline health bar with the score. Compact form for table rows. */
export function HealthBar({
  health,
  compact = false,
  className,
}: {
  health: ReqHealthWire;
  compact?: boolean;
  className?: string;
}) {
  const tone = healthTone(health.score);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className={cn(
          "overflow-hidden rounded-full bg-neutral-100",
          compact ? "h-2 w-24" : "h-2.5 flex-1",
        )}
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-300",
            HEALTH_FILL[tone],
          )}
          style={{ width: `${health.score}%` }}
          aria-hidden
        />
      </span>
      <span className={cn("shrink-0 text-xs font-semibold tabular-nums", HEALTH_TEXT[tone])}>
        {health.score}
      </span>
    </div>
  );
}

const DIFFICULTY_META: Record<ReqDifficultyWire, { label: string; cls: string }> = {
  low: { label: "Low", cls: "bg-status-positive-50 text-status-positive-700" },
  medium: { label: "Medium", cls: "bg-status-warning-50 text-status-warning-800" },
  high: { label: "High", cls: "bg-status-error-50 text-status-error-700" },
};

export function DifficultyChip({ difficulty }: { difficulty: ReqDifficultyWire }) {
  const m = DIFFICULTY_META[difficulty];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-neutral-100 text-neutral-600" },
  pending_approval: {
    label: "Pending approval",
    cls: "bg-status-warning-50 text-status-warning-800",
  },
  approved: { label: "Approved", cls: "bg-status-positive-50 text-status-positive-700" },
  posted: { label: "Live", cls: "bg-status-info-50 text-status-info-700" },
  on_hold: { label: "On hold", cls: "bg-status-warning-50 text-status-warning-800" },
  filled: { label: "Filled", cls: "bg-status-positive-50 text-status-positive-700" },
  cancelled: { label: "Rejected", cls: "bg-status-error-50 text-status-error-700" },
  closed: { label: "Closed", cls: "bg-neutral-100 text-neutral-600" },
};

export function ReqStatusChip({ status }: { status: string }) {
  const m = STATUS_META[status] ?? {
    label: status.replace(/_/g, " "),
    cls: "bg-neutral-100 text-neutral-600",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

/** A waiting-time chip that turns red when the approval SLA is breached. */
export function WaitingChip({ hours, breach }: { hours: number; breach: boolean }): ReactNode {
  const label = hours >= 48 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
        breach ? "bg-status-error-50 text-status-error-700" : "bg-neutral-100 text-neutral-600",
      )}
    >
      {label}
      {breach ? " · SLA" : ""}
    </span>
  );
}

export function formatReqDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
