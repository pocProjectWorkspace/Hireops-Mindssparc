import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /admin/roles. */
export default function RolesLoading() {
  return (
    <AppShellSkeleton title="Roles & permissions">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <SkeletonRows count={8} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
