import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PanelFeedbackQueue } from "@/components/panel/PanelFeedbackQueue";

export const dynamic = "force-dynamic"; // Auth-gated + reads live feedback state.

/**
 * PANEL-01 — /panel/feedback. The panellist's feedback queue: pending scorecards
 * (Score-now) + submitted (with my recommendation). panel_member + admin.
 */

const PANEL_ROLES = ["panel_member", "admin"];

export default async function PanelFeedbackPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => PANEL_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Feedback"
        isAdmin={isAdmin}
        roles={session.roles}
        active="panel-feedback"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Feedback isn't available for your role"
          hint="This surface is for interview panellists. Ask an administrator if you need access."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const board = await caller.getPanelDashboard();

  return (
    <AppShell
      title="Feedback"
      isAdmin={isAdmin}
      roles={session.roles}
      active="panel-feedback"
      user={sessionUserChip(session)}
    >
      <PanelFeedbackQueue board={board} />
    </AppShell>
  );
}
