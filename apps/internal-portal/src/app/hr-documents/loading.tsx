import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles, SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /hr-documents. */
export default function HrDocumentsLoading() {
  return (
    <AppShellSkeleton title="Documents">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonTiles count={4} />
        <div className="mt-6">
          <SkeletonRows count={4} barClassName="h-20" />
        </div>
      </div>
    </AppShellSkeleton>
  );
}
