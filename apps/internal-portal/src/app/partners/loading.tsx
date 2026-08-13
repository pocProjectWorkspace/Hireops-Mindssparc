import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /partners — the page itself is a server
 * component so a direct load arrives with data.
 */
export default function PartnersLoading() {
  return (
    <AppShellSkeleton title="Partners">
      <div className="w-full px-4 py-6 lg:px-8">
        <SkeletonRows count={6} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
