import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/branding — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function BrandingLoading() {
  return (
    <AppShellSkeleton title="Theme & branding">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <SkeletonRows count={2} barClassName="h-56" />
      </div>
    </AppShellSkeleton>
  );
}
