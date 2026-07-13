import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/audit — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function AuditLoading() {
  return (
    <AppShellSkeleton title="Audit Trail">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={5} barClassName="h-14" />
      </div>
    </AppShellSkeleton>
  );
}
