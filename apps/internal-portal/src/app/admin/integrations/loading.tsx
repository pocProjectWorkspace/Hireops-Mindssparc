import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles, SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/integrations. Mirrors the page's
 * summary-tiles-over-list shape inside the shell skeleton.
 */
export default function IntegrationsLoading() {
  return (
    <AppShellSkeleton title="Integration Health">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonTiles count={3} className="mb-8 sm:grid-cols-3" />
        <SkeletonRows count={5} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
