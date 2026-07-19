import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { CaseAuditView } from "@/components/case-audit/CaseAuditView";

export const dynamic = "force-dynamic"; // Auth-gated + reads live audit state.

/**
 * HROPS-03 — Case audit trail. The per-application audit timeline for hr_ops:
 * every trigger-written audit event (stage transitions, offer lifecycle,
 * document verification) plus HR notes, per case, newest activity first.
 * hr_ops + admin only (HR_OPS_DOC_ROLES).
 */

const ALLOWED_ROLES = ["hr_ops", "admin"];

export default async function CaseAuditPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => ALLOWED_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Case audit"
        isAdmin={isAdmin}
        roles={session.roles}
        active="case-audit"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Case audit isn't available for your role"
          hint="This surface is for HR operations. If you need access, ask an administrator to update your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listCaseAuditCases({ limit: 100 });

  return (
    <AppShell
      title="Case audit"
      isAdmin={isAdmin}
      roles={session.roles}
      active="case-audit"
      user={sessionUserChip(session)}
    >
      <CaseAuditView initial={initial} />
    </AppShell>
  );
}
