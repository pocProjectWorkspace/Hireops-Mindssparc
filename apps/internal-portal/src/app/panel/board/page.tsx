import { requireAuth, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { SessionBoard } from "@/components/panel/SessionBoard";

export const dynamic = "force-dynamic"; // Auth-gated + reads live interview state.

/**
 * PANEL-02 — the panellist session board ("All interviews"). A board/list of
 * the signed-in panellist's interviews with filters (Upcoming / Past / All),
 * search, an "in window now" accent, and Brief / Join / Scorecard actions.
 * Distinct from /panel ("My interviews", the table) — same data, board layout.
 *
 * Persona-gated to panel_member / admin (the listMyPanelInterviews API enforces
 * the same). A direct hit by another role gets a calm in-shell notice.
 */

const PANEL_ROLES = ["panel_member", "admin"];

export default async function PanelBoardPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => PANEL_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="All interviews"
        isAdmin={isAdmin}
        roles={session.roles}
        active="panel-board"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="The interview board isn't available for your role"
          hint="This surface is for interview panellists. Ask an administrator if you need access."
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="All interviews"
      isAdmin={isAdmin}
      roles={session.roles}
      active="panel-board"
      user={sessionUserChip(session)}
    >
      <SessionBoard />
    </AppShell>
  );
}
