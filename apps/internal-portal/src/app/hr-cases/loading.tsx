import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

export default function HrCasesLoading() {
  return (
    <AppShellSkeleton title="HR cases">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
