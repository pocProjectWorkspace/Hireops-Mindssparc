import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /panel/history. */
export default function PanelHistoryLoading() {
  return (
    <AppShellSkeleton title="History">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={5} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
