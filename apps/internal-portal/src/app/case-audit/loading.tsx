import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles, SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /case-audit. */
export default function CaseAuditLoading() {
  return (
    <AppShellSkeleton title="Case audit">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonTiles count={3} />
        <div className="mt-6">
          <SkeletonRows count={4} barClassName="h-16" />
        </div>
      </div>
    </AppShellSkeleton>
  );
}
