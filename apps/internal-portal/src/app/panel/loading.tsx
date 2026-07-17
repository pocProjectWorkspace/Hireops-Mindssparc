import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /panel — the page is a server component
 * so a direct load arrives with data.
 */
export default function PanelLoading() {
  return (
    <AppShellSkeleton title="My interviews">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
