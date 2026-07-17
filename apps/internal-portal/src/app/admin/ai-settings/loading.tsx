import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/ai-settings — the page itself
 * is a server component so a direct load arrives with data.
 */
export default function AiSettingsLoading() {
  return (
    <AppShellSkeleton title="AI settings">
      <div className="mx-auto w-full max-w-3xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-36" />
      </div>
    </AppShellSkeleton>
  );
}
