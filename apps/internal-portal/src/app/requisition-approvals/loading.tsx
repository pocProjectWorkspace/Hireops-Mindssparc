import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /requisition-approvals — the page
 * itself is a server component so a direct load arrives with data.
 */
export default function RequisitionApprovalsLoading() {
  return (
    <AppShellSkeleton title="Req approvals">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={3} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
