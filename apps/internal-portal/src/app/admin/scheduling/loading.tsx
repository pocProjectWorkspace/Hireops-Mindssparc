import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

export default function SchedulingSettingsLoading() {
  return (
    <AppShellSkeleton title="Interview scheduling">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <SkeletonRows count={8} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
