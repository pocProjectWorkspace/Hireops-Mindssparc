import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { HrRoundsView } from "@/components/hr-ops/HrRoundsView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live interview state.

/**
 * HROPS-01 — the HR-round scheduler + assessment view.
 *
 * Lists HR-round interviews (scorecard template 'hr') for cases in the HR-Ops
 * window, plus any hr_round case with no HR interview scheduled yet (shown as
 * Pending with a Schedule link into the existing scheduling surface). Complete
 * opens the SAME assessment form used on the case detail HR-round tab, in a
 * modal. hr_ops / admin.
 */

const READ_ROLES = ["hr_ops", "admin"];

export default async function HrRoundsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="HR rounds"
        isAdmin={isAdmin}
        roles={session.roles}
        active="hr-rounds"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="HR rounds isn't available for your role"
          hint="This view is for the HR Ops team. Ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listHrRounds();

  return (
    <AppShell
      title="HR rounds"
      isAdmin={isAdmin}
      roles={session.roles}
      active="hr-rounds"
      user={sessionUserChip(session)}
    >
      <HrRoundsView initial={initial} />
    </AppShell>
  );
}
