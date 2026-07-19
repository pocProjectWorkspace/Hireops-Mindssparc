import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /panel/board — the page is a server
 * component so a direct load arrives with data.
 */
export default function PanelBoardLoading() {
  return (
    <AppShellSkeleton title="All interviews">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-20" />
      </div>
    </AppShellSkeleton>
  );
}
