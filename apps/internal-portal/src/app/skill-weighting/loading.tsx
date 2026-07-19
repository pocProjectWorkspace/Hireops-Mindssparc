import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /skill-weighting. */
export default function SkillWeightingLoading() {
  return (
    <AppShellSkeleton title="Skill weighting">
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-14" />
      </div>
    </AppShellSkeleton>
  );
}
