import { AppShellSkeleton } from "@/components/nav/AppShell";
import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into a case detail — the page itself is a
 * server component so a direct load arrives with data.
 */
export default function OnboardingCaseLoading() {
  return (
    <AppShellSkeleton title="Onboarding">
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <Skeleton className="mb-6 h-40 w-full rounded-md" />
        <SkeletonRows count={4} barClassName="h-14" />
      </div>
    </AppShellSkeleton>
  );
}
