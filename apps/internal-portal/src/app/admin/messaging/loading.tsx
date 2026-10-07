import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows, SkeletonTiles } from "@/components/ui";

/**
 * Shown while /admin/messaging loads its data, so navigation never lands on a blank page.
 */
export default function MessagingLoading() {
  return (
    <AppShellSkeleton title="Messaging">
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <SkeletonTiles count={3} className="mb-6 sm:grid-cols-3" />
        <SkeletonRows count={6} barClassName="h-12" />
      </div>
    </AppShellSkeleton>
  );
}
