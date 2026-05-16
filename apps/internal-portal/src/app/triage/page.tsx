import { requireAuth } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { TriageRow } from "@/components/TriageRow";
import { TriageEmptyState } from "@/components/TriageEmptyState";

export const dynamic = "force-dynamic"; // Auth-gated; never statically render.

/**
 * Module 1a triage stub. Server-renders the candidate list from the
 * listCandidates tRPC procedure — read-only, no filters, no actions,
 * no detail drawer. Module 1b layers the interactive triage workflow
 * on top of this same page.
 */
export default async function TriagePage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);
  const result = await caller.listCandidates({
    pagination: { limit: 50 },
    sort: "recent",
  });

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-neutral-900">Triage</h1>
        <a href="/logout" className="text-sm text-neutral-600 underline hover:text-neutral-900">
          Sign out
        </a>
      </header>
      {result.rows.length === 0 ? (
        <TriageEmptyState />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-1">
          {result.rows.map((c) => (
            <TriageRow key={c.candidateId} candidate={c} />
          ))}
        </ul>
      )}
    </main>
  );
}
