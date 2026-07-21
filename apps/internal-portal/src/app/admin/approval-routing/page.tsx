import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { ApprovalRoutingClient } from "./ApprovalRoutingClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Approval Routing (T1.3 / G13, option b) — configurable approval matrices.
 *
 * The admin authors WHO approves each chain (requisition + out-of-band offer) and
 * WHEN the policy takes effect. Each matrix is a single approver step: the
 * requisition/offer approval resolvers derive their chain's steps from the
 * matrix that is in force right now, so changing the approver role here actually
 * reroutes the next approval. Effective-dated — the newest in-force policy wins,
 * and a future-dated policy schedules a change without touching today's routing.
 *
 * Deliberately single-approver: multi-step routing would be silently ignored by
 * the decision spine, so it is not authored here (it is honestly labelled as
 * planned). Admin-gated twice: requireAdmin (page redirect) AND the
 * listApprovalMatrices / upsertApprovalMatrix procedures (server-side admin role).
 */
export default async function ApprovalRoutingPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listApprovalMatrices({});

  return (
    <AppShell
      title="Approval routing"
      isAdmin
      active="approval-routing"
      user={sessionUserChip(session)}
    >
      <ApprovalRoutingClient initial={initial.matrices} />
    </AppShell>
  );
}
