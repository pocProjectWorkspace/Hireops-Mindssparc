import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/report-digests — the page itself is
 * a server component so a direct load arrives with data.
 */
export default function ReportDigestsLoading() {
  return (
    <AppShellSkeleton title="Report digests">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
        <SkeletonRows count={4} barClassName="h-24" />
      </div>
    </AppShellSkeleton>
  );
}
