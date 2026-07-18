import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonTiles } from "@/components/ui";

/** Covers client-side navigations into /exec-audit (server component page). */
export default function ExecAuditLoading() {
  return (
    <AppShellSkeleton title="Executive audit">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <SkeletonTiles count={4} className="mb-8 sm:grid-cols-2 lg:grid-cols-4" />
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-card border border-neutral-200 bg-neutral-100"
            />
          ))}
        </div>
      </div>
    </AppShellSkeleton>
  );
}
