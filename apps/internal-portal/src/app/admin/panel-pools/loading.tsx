import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/panel-pools — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function PanelPoolsLoading() {
  return (
    <AppShellSkeleton title="Panel pools">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={6} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
