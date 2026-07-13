import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Avatar — a deterministic initials chip. The background/foreground pair is
 * chosen by hashing a stable seed (candidate id or name) into one of a small
 * set of soft tints drawn only from the neutral + brand ramps — colour reads
 * as identity, never as status, and stays inside the DESIGN-01 palette.
 *
 * `name` supplies the initials (first letters of the first two words);
 * `seed` (falls back to `name`) is what the colour hashes on, so the same
 * person keeps the same colour across rows and the drawer.
 */
export type AvatarSize = "sm" | "md" | "lg";

const SIZES: Record<AvatarSize, string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
};

// Soft {bg, text} pairs from the neutral + brand ramps only. Deterministic
// pick keeps identity colour on-brand and scarce — no status hues here.
const PALETTE: string[] = [
  "bg-brand-100 text-brand-700",
  "bg-brand-50 text-brand-600",
  "bg-brand-200 text-brand-800",
  "bg-neutral-200 text-neutral-700",
  "bg-neutral-100 text-neutral-600",
  "bg-neutral-300 text-neutral-800",
];

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0] ?? "";
  if (words.length === 1) return first.slice(0, 2).toUpperCase();
  const last = words[words.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

export interface AvatarProps {
  name?: string | null;
  seed?: string;
  size?: AvatarSize;
  className?: string;
  children?: ReactNode;
}

export function Avatar({ name, seed, size = "md", className, children }: AvatarProps) {
  const label = (name ?? "").trim();
  const initials = children ? null : initialsOf(label || "?");
  const tint = PALETTE[hash(seed ?? label ?? "?") % PALETTE.length] ?? PALETTE[0];

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-tight",
        SIZES[size],
        tint,
        className,
      )}
    >
      {children ?? initials}
    </span>
  );
}
