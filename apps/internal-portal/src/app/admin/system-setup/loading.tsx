import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Shown while /admin/system-setup loads its data, so navigation never lands on a blank page.
 */
export default function SystemSetupLoading() {
  return (
    <AppShellSkeleton title="System setup">
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <SkeletonRows count={5} barClassName="h-24" />
      </div>
    </AppShellSkeleton>
  );
}
