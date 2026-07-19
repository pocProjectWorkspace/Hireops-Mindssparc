import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles } from "@/components/ui";

/** Covers client-side navigations into /hr-policies. */
export default function HrPoliciesLoading() {
  return (
    <AppShellSkeleton title="Policies">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonTiles count={6} />
      </div>
    </AppShellSkeleton>
  );
}
