import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Shown while /feasibility loads its data, so navigation never lands on a blank page.
 */
export default function FeasibilityLoading() {
  return (
    <AppShellSkeleton title="Feasibility">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonRows count={6} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
