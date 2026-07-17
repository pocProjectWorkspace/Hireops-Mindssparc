import { AppShellSkeleton } from "@/components/nav/AppShell";
import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into a panel interview detail — the page is a
 * server component so a direct load arrives with data.
 */
export default function PanelInterviewLoading() {
  return (
    <AppShellSkeleton title="My interviews">
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <Skeleton className="mb-6 h-32 w-full rounded-md" />
        <SkeletonRows count={5} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
