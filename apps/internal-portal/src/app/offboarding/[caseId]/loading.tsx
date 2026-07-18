import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into an offboarding case detail. */
export default function OffboardingCaseLoading() {
  return (
    <AppShellSkeleton title="Offboarding">
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <SkeletonRows count={5} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
