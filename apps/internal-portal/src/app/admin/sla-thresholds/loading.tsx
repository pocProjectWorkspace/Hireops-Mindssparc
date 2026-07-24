import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/sla-thresholds — the page itself
 * is a server component so a direct load arrives with data.
 */
export default function SlaThresholdsLoading() {
  return (
    <AppShellSkeleton title="SLA thresholds">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <SkeletonRows count={7} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
