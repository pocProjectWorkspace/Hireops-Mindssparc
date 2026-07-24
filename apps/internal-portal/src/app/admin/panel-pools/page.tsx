import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PanelPoolsClient } from "./PanelPoolsClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Panel pools (T3.3 / G16) — the interview-panel-pool library.
 *
 * A tenant's panel-pool library is REAL config that drives interview planning:
 * the owner plan-setup pool picker reads this managed, non-archived list, and
 * picking a pool on a round COPIES the pool's members into the round's default
 * panel (which INT-02 seeds interview_panelists from). Not a decorative dropdown.
 * The round keeps panel_pool_id as provenance, so a manual override reads as a
 * divergence from the linked pool.
 *
 * Gated to the WRITE roles (admin + recruiter). Double-gated: this redirect AND
 * the write procedures (createPanelPool / renamePanelPool / setPanelPoolMembers /
 * setPanelPoolArchived enforce the admin/recruiter roles server-side).
 * Server-prefetches the full list (including archived) + the tenant's
 * memberships so the surface lands populated.
 */
export default async function PanelPoolsPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("recruiter")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const [initial, memberships] = await Promise.all([
    caller.listPanelPools({ includeArchived: true }),
    caller.listTenantMemberships(),
  ]);

  return (
    <AppShell title="Panel pools" isAdmin active="panel-pools" user={sessionUserChip(session)}>
      <PanelPoolsClient initial={initial} memberships={memberships} />
    </AppShell>
  );
}
