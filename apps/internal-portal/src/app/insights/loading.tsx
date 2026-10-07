import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles } from "@/components/ui";

/**
 * Shown while /insights loads its data, so navigation never lands on a blank page.
 */
export default function InsightsLoading() {
  return (
    <AppShellSkeleton title="Insights">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonTiles count={4} className="mb-8" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-[280px] animate-pulse rounded-card border border-neutral-200 bg-neutral-200"
            />
          ))}
        </div>
      </div>
    </AppShellSkeleton>
  );
}
