import { requireAuth } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { ApprovalQueue } from "@/components/approvals/ApprovalQueue";

export const dynamic = "force-dynamic"; // Auth-gated + reads live queue state.

/**
 * The approval queue — where agent actions that need a human land.
 *
 * This is the visible half of the wedge: an agent drafts, a recruiter
 * reviews here, approves (or edits, or rejects), and the action executes.
 * Server-renders the pending list via the in-process tRPC caller so the
 * screen lands with data; the client ApprovalQueue keeps it live and owns
 * the resolve mutations.
 *
 * Recruiter-accessible (not admin-gated): resolution is authorized by
 * recruiter role in the API (ensureCanResolveApproval), and the demo
 * narration has the recruiter working this queue.
 */
export default async function ApprovalsPage() {
  const session = await requireAuth();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listPendingApprovals({ limit: 50 });

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold text-neutral-900">Approvals</h1>
          <a href="/triage" className="text-sm text-neutral-500 underline hover:text-neutral-900">
            Triage
          </a>
        </div>
        <a href="/logout" className="text-sm text-neutral-600 underline hover:text-neutral-900">
          Sign out
        </a>
      </header>
      <ApprovalQueue initial={initial} />
    </main>
  );
}
