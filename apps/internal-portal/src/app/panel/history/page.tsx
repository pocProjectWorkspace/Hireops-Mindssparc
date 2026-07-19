import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PanelHistory } from "@/components/panel/PanelHistory";

export const dynamic = "force-dynamic"; // Auth-gated + reads my submitted feedback.

/**
 * PANEL-01 — /panel/history. A table of my completed + submitted interviews with
 * my avg score + recommendation, searchable + round-filterable. panel_member +
 * admin.
 */

const PANEL_ROLES = ["panel_member", "admin"];

export default async function PanelHistoryPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => PANEL_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="History"
        isAdmin={isAdmin}
        roles={session.roles}
        active="panel-history"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="History isn't available for your role"
          hint="This surface is for interview panellists. Ask an administrator if you need access."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const board = await caller.getPanelDashboard();

  return (
    <AppShell
      title="History"
      isAdmin={isAdmin}
      roles={session.roles}
      active="panel-history"
      user={sessionUserChip(session)}
    >
      <PanelHistory initialBoard={board} />
    </AppShell>
  );
}
