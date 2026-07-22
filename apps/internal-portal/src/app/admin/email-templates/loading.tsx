import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/email-templates — the page itself
 * is a server component so a direct load arrives with data.
 */
export default function EmailTemplatesLoading() {
  return (
    <AppShellSkeleton title="Email templates">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonRows count={6} barClassName="h-14" />
      </div>
    </AppShellSkeleton>
  );
}
