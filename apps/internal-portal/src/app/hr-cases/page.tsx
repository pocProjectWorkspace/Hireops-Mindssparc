import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { HrCasesWorkspace } from "@/components/hr-ops/HrCasesWorkspace";

export const dynamic = "force-dynamic"; // Auth-gated + reads live case state.

/**
 * HROPS-01 — the HR Ops cases workspace.
 *
 * An "HR case" is an application in the post-technical-rounds window
 * (tech_interview / hr_round / offer_drafted / offer_accepted). The HR Ops
 * team works these on the way to an offer. Server-renders the enriched list;
 * the client HrCasesWorkspace owns the hero-stat strip, search + stage filter,
 * and the rich table (each row opens the case detail).
 *
 * Persona-gated to hr_ops / admin — the nav only surfaces it to those roles and
 * the API enforces the same set. A direct hit by another role gets a calm
 * in-shell notice.
 */

const READ_ROLES = ["hr_ops", "admin"];

export default async function HrCasesPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="HR cases"
        isAdmin={isAdmin}
        roles={session.roles}
        active="hr-cases"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="HR cases isn't available for your role"
          hint="This workspace is for the HR Ops team. If you need access, ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listHrCases({});

  return (
    <AppShell
      title="HR cases"
      isAdmin={isAdmin}
      roles={session.roles}
      active="hr-cases"
      user={sessionUserChip(session)}
    >
      <HrCasesWorkspace initial={initial} />
    </AppShell>
  );
}
