import { requireAuth, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PanelInterviewsListView } from "@/components/panel/PanelInterviewsListView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live interview state.

/**
 * INT-03 — the panel/interviewer surface. "My interviews": the interviews the
 * signed-in panellist is on, split upcoming/past, with a feedback-state badge
 * per row. Distinct from /interviews (the recruiter scheduling surface).
 *
 * Persona-gated to panel_member / admin (the API enforces the same, and each
 * detail read additionally enforces panelist-on-that-interview). A direct hit
 * by another role gets a calm in-shell notice.
 */

const PANEL_ROLES = ["panel_member", "admin"];

export default async function PanelPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => PANEL_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="My interviews"
        isAdmin={isAdmin}
        roles={session.roles}
        active="panel"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="My interviews isn't available for your role"
          hint="This surface is for interview panellists. Ask an administrator if you need access."
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="My interviews"
      isAdmin={isAdmin}
      roles={session.roles}
      active="panel"
      user={sessionUserChip(session)}
    >
      <PanelInterviewsListView />
    </AppShell>
  );
}
