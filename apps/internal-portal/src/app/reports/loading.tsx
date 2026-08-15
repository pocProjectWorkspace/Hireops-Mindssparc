import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles, SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /reports — the page itself is a server
 * component so a direct load arrives with data. Geometry matches the catalog:
 * filter bar, four aging tiles, then the two report tables.
 */
export default function ReportsHubLoading() {
  return (
    <AppShellSkeleton title="Reports">
      <div className="w-full px-4 py-6 lg:px-8">
        <div className="mb-8 h-12 animate-pulse rounded-card border border-neutral-200 bg-neutral-100" />
        <SkeletonTiles count={4} className="mb-6" />
        <SkeletonRows count={6} barClassName="h-10" />
        <div className="h-6" />
        <SkeletonRows count={4} barClassName="h-10" />
      </div>
    </AppShellSkeleton>
  );
}
