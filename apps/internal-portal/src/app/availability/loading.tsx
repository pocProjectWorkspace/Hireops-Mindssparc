import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

export default function AvailabilityLoading() {
  return (
    <AppShellSkeleton title="My availability">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <SkeletonRows count={5} barClassName="h-10" />
      </div>
    </AppShellSkeleton>
  );
}
