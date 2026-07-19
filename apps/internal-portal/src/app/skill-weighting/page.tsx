import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { SkillWeightingWorkspace } from "@/components/requisitions/SkillWeightingWorkspace";

export const dynamic = "force-dynamic"; // Auth-gated + reads live requisition state.

/**
 * RO-02 — the standalone /skill-weighting surface. Pick a requisition (with a
 * skill-coverage summary) and tune its skill weights in the same
 * SkillWeightsEditor the wizard uses. hiring_manager + admin only (matches the
 * listRequisitionsForSkillWeighting API gate). Weights are editable only while
 * a requisition is a draft; posted/approved reqs show read-only.
 */

const WRITE_ROLES = ["hiring_manager", "admin"];

export default async function SkillWeightingPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => WRITE_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Skill weighting"
        isAdmin={isAdmin}
        roles={session.roles}
        active="skill-weighting"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Skill weighting isn't available for your role"
          hint="This surface is for hiring managers. Ask an administrator to add the hiring_manager role if you need it."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const { rows } = await caller.listRequisitionsForSkillWeighting({ limit: 50 });

  return (
    <AppShell
      title="Skill weighting"
      isAdmin={isAdmin}
      roles={session.roles}
      active="skill-weighting"
      user={sessionUserChip(session)}
    >
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <SkillWeightingWorkspace rows={rows} />
      </div>
    </AppShell>
  );
}
