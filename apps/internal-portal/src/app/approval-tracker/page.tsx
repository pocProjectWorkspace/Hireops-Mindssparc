import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { ApprovalTracker } from "@/components/requirements/ApprovalTracker";

export const dynamic = "force-dynamic"; // Auth-gated + reads live approval state.

/**
 * RO-01 — the requirement-owner Approval Tracker (/approval-tracker).
 *
 * Server-renders the tracker (pending / approved / rejected stats, pending SLA,
 * approval history with the HR-head decision reason, and AI revision suggestions
 * for rejected reqs) via getApprovalTracker. Persona-gated to hiring_manager /
 * admin, enforced by the API too; a direct hit by another role gets a calm
 * in-shell notice.
 */

const READ_ROLES = ["hiring_manager", "admin"];

export default async function ApprovalTrackerPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Approval tracker"
        isAdmin={isAdmin}
        roles={session.roles}
        active="approval-tracker"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Approval tracker isn't available for your role"
          hint="This surface is for hiring managers. If you need access, ask an administrator to add the hiring_manager role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.getApprovalTracker();

  return (
    <AppShell
      title="Approval tracker"
      isAdmin={isAdmin}
      roles={session.roles}
      active="approval-tracker"
      user={sessionUserChip(session)}
    >
      <ApprovalTracker initial={initial} displayName={session.email?.split("@")[0] ?? "there"} />
    </AppShell>
  );
}
