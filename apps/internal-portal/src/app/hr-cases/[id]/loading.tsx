import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

export default function HrCaseDetailLoading() {
  return (
    <AppShellSkeleton title="HR cases">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={3} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
