import { AppShellSkeleton } from "@/components/nav/AppShell";
import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Shown while /ask-data loads its data, so navigation never lands on a blank page.
 */
export default function AskDataLoading() {
  return (
    <AppShellSkeleton title="Ask your data">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <Skeleton className="mb-4 h-14" />
        <SkeletonRows count={2} barClassName="h-9" className="mb-8" />
        <Skeleton variant="tile" className="h-64" />
      </div>
    </AppShellSkeleton>
  );
}
