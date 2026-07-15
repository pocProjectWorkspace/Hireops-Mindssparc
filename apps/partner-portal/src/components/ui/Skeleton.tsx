import { cn } from "./cn";

/**
 * Skeleton — the shared loading placeholder. `bar` is a single line/row
 * placeholder (default); `tile` is a KPI-tile-sized block. Compose several
 * to mirror a page's real shape inside loading.tsx so navigation reads as
 * instant rather than blank.
 */
export interface SkeletonProps {
  variant?: "bar" | "tile";
  className?: string;
}

export function Skeleton({ variant = "bar", className }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse bg-neutral-100",
        variant === "tile" ? "h-20 rounded-md" : "h-12 rounded-md",
        className,
      )}
    />
  );
}

/** A row of N tile skeletons on the standard KPI grid. */
export function SkeletonTiles({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-4", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} variant="tile" />
      ))}
    </div>
  );
}

/** A stack of N bar skeletons — the generic list/table placeholder. */
export function SkeletonRows({
  count = 4,
  barClassName,
  className,
}: {
  count?: number;
  barClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={barClassName} />
      ))}
    </div>
  );
}
