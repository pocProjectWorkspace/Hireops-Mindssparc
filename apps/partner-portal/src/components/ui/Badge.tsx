import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Badge — a small status/label pill. Tone maps to the semantic ramps
 * (status colours = status only) plus a neutral default and an accent
 * (brand) tone for interactive/active labels. 6px radius by default;
 * pass `pill` for a fully-rounded count/tag chip.
 */
export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "accent"
  | "gold"
  | "platinum"
  | "silver";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  success: "bg-status-positive-50 text-status-positive-700",
  warning: "bg-status-warning-50 text-status-warning-800",
  error: "bg-status-error-50 text-status-error-700",
  info: "bg-status-info-50 text-status-info-800",
  accent: "bg-brand-50 text-brand-700",
  gold: "bg-tier-gold-bg text-tier-gold-fg ring-1 ring-inset ring-tier-gold-border",
  platinum: "bg-tier-platinum-bg text-tier-platinum-fg ring-1 ring-inset ring-tier-platinum-border",
  silver: "bg-tier-silver-bg text-tier-silver-fg ring-1 ring-inset ring-tier-silver-border",
};

export interface BadgeProps {
  tone?: BadgeTone;
  pill?: boolean;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "neutral", pill = false, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-xs font-medium",
        pill ? "rounded-full" : "rounded-button",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
