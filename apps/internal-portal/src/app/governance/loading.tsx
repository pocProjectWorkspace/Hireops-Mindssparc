import { AppShellSkeleton } from "@/components/nav/AppShell";

/** Covers client-side navigations into /governance (server component page). */
export default function GovernanceLoading() {
  return (
    <AppShellSkeleton title="Governance">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-card border border-neutral-200 bg-neutral-100"
          />
        ))}
      </div>
    </AppShellSkeleton>
  );
}
