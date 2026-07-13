import { AppShellSkeleton } from "@/components/nav/AppShell";
import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Rarely shown — the page is a server component so initial render arrives with
 * data. Covers client-side navigations into /triage; renders inside the shell
 * skeleton so the frame stays put and only the body swaps.
 */
export default function TriageLoading() {
  return (
    <AppShellSkeleton title="Triage">
      <div className="border-b border-neutral-200 bg-white px-6 py-3">
        <Skeleton className="h-6 w-64" />
      </div>
      <div className="px-6 py-4">
        <SkeletonRows count={5} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
