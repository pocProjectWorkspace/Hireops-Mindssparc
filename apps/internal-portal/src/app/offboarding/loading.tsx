import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /offboarding — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function OffboardingLoading() {
  return (
    <AppShellSkeleton title="Offboarding">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-20" />
      </div>
    </AppShellSkeleton>
  );
}
