import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { FeasibilityView } from "@/components/market/FeasibilityView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live req + assessment state.

/**
 * HRHEAD-02 — Feasibility Reports (REAL AI).
 *
 * The prototype's feasibility cards FAKE their fit percentages + prose. Here
 * each card's assessment is a real Claude verdict (requisition_feasibility),
 * generated on an explicit click and cached. hr_head + admin. A direct hit by
 * another role gets a calm in-shell notice.
 */

const ROLES = ["hr_head", "admin"];

export default async function FeasibilityPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Feasibility"
        isAdmin={isAdmin}
        roles={session.roles}
        active="feasibility"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Feasibility isn't available for your role"
          hint="This surface is for the HR head. If you need access, ask an administrator to add the hr_head role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listRequisitionFeasibility({});

  return (
    <AppShell
      title="Feasibility"
      isAdmin={isAdmin}
      roles={session.roles}
      active="feasibility"
      user={sessionUserChip(session)}
    >
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <FeasibilityView initial={initial} />
      </div>
    </AppShell>
  );
}
