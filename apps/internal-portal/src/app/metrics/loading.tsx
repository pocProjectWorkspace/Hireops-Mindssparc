import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles } from "@/components/ui";

/**
 * Covers client-side navigations into /metrics — the page itself is a server
 * component so a direct load arrives with data.
 */
export default function MetricsLoading() {
  return (
    <AppShellSkeleton title="Metrics">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonTiles count={5} className="mb-8 sm:grid-cols-3 lg:grid-cols-5" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-[300px] animate-pulse rounded-card border border-neutral-200 bg-neutral-100"
            />
          ))}
        </div>
      </div>
    </AppShellSkeleton>
  );
}
