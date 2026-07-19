import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PanelSetupClient } from "./PanelSetupClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live plan state.

/**
 * RO-03 — /panel-setup.
 *
 * A pick-a-requisition view over MY requisitions (with a plan summary: round
 * count, total duration, templates used) and, per requisition, a pipeline
 * visualization of the interview loop plus the existing InterviewPlanSection
 * editor embedded as-is. The plan carries advisory default panellists, surfaced
 * read-only; actual per-round panel assignment happens at scheduling
 * (/interviews).
 *
 * hiring_manager + admin (nav + API enforce the same). Scoped to my reqs.
 */

const READ_ROLES = ["hiring_manager", "admin"];

export default async function PanelSetupPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Panel setup"
        isAdmin={isAdmin}
        roles={session.roles}
        active="panel-setup"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Panel setup isn't available for your role"
          hint="This surface is for hiring managers. If you need access, ask an administrator to add the hiring_manager role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listPanelSetupRequisitions({ limit: 100 });

  return (
    <AppShell
      title="Panel setup"
      isAdmin={isAdmin}
      roles={session.roles}
      active="panel-setup"
      user={sessionUserChip(session)}
    >
      <PanelSetupClient initial={initial} />
    </AppShell>
  );
}
