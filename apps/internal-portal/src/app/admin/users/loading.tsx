import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/users — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function UsersAdminLoading() {
  return (
    <AppShellSkeleton title="Users & roles">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <SkeletonRows count={5} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
