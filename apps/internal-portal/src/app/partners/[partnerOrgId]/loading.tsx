import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into a partner org's detail — the page itself
 * is a server component so a direct load arrives with data.
 */
export default function PartnerOrgDetailLoading() {
  return (
    <AppShellSkeleton title="Partners">
      <div className="w-full px-4 py-6 lg:px-8">
        <SkeletonRows count={4} barClassName="h-28" />
      </div>
    </AppShellSkeleton>
  );
}
