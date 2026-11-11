import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /admin/labels. */
export default function LabelsLoading() {
  return (
    <AppShellSkeleton title="Labels">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <SkeletonRows count={8} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
