import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows, SkeletonTiles } from "@/components/ui";

/**
 * Shown while /dashboard loads its data, so navigation never lands on a blank page.
 */
export default function DashboardLoading() {
  return (
    <AppShellSkeleton title="Home">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonTiles count={4} className="mb-8" />
        <SkeletonRows count={5} barClassName="h-14" />
      </div>
    </AppShellSkeleton>
  );
}
