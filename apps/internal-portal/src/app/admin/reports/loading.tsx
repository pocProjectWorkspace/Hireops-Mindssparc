import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles, SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/reports — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function ReportsLoading() {
  return (
    <AppShellSkeleton title="Reports">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonTiles count={4} className="mb-8" />
        <SkeletonRows count={5} barClassName="h-10" />
      </div>
    </AppShellSkeleton>
  );
}
