import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /admin/lists (C1-F3). */
export default function ListsLoading() {
  return (
    <AppShellSkeleton title="Lists">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={6} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
