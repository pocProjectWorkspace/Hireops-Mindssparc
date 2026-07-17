import { requireAuth, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { InterviewsListView } from "@/components/interviews/InterviewsListView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live interview state.

/**
 * INT-02 — recruiter upcoming-interviews surface. Lists the tenant's
 * scheduled/completed/cancelled interviews with candidate + role + panel +
 * confirmed state, filterable by status, with reschedule/cancel actions.
 *
 * Persona-gated to hiring_manager / recruiter / admin (the API enforces the
 * same). A direct hit by another role gets a calm in-shell notice.
 */

const READ_ROLES = ["hiring_manager", "recruiter", "admin"];

export default async function InterviewsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Interviews"
        isAdmin={isAdmin}
        roles={session.roles}
        active="interviews"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Interviews isn't available for your role"
          hint="This surface is for recruiters and hiring managers. Ask an administrator if you need access."
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Interviews"
      isAdmin={isAdmin}
      roles={session.roles}
      active="interviews"
      user={sessionUserChip(session)}
    >
      <InterviewsListView />
    </AppShell>
  );
}
