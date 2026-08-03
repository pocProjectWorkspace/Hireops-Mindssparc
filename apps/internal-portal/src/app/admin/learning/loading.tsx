import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/learning — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function LearningLoading() {
  return (
    <AppShellSkeleton title="Learning">
      <div className="w-full px-4 py-6 lg:px-8">
        <SkeletonRows count={6} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
