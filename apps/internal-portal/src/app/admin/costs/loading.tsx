import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles, SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/costs — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function CostsLoading() {
  return (
    <AppShellSkeleton title="AI Cost">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonTiles count={5} className="mb-8 sm:grid-cols-3 lg:grid-cols-5" />
        <SkeletonRows count={3} barClassName="h-14" />
      </div>
    </AppShellSkeleton>
  );
}
