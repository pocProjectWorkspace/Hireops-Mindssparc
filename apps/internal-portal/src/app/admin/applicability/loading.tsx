import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /admin/applicability (C2-F12). */
export default function ApplicabilityLoading() {
  return (
    <AppShellSkeleton title="Applicability">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={6} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
