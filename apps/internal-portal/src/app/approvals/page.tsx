import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
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
    <AppShell
      title="Approvals"
      isAdmin={session.roles.includes("admin")}
      roles={session.roles}
      active="approvals"
      user={sessionUserChip(session)}
      fill
    >
      <ApprovalQueue initial={initial} />
    </AppShell>
  );
}
