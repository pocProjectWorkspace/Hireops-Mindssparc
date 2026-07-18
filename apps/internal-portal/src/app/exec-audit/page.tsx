import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { ExecAuditClient } from "./ExecAuditClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live pipeline/compliance data.

/**
 * HRHEAD-03 — Executive Audit & Governance (persona pass 3/3).
 *
 * The HR head's compliance dashboard: a composite compliance score (four real
 * weighted ratios), a KPI row, the deterministic risk-alert feed with severity
 * filters, and a per-stage SLA compliance table (real medians vs declared
 * targets). Every number is computed from live tables in ONE getExecutiveAudit
 * call — no AI, no demographic anything.
 *
 * hr_head + admin only, enforced twice (page notice + the procedure).
 */

const READ_ROLES = ["hr_head", "admin"];

export default async function ExecAuditPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Executive audit"
        isAdmin={isAdmin}
        roles={session.roles}
        active="exec-audit"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Executive audit isn't available for your role"
          hint="This compliance surface is for the HR head. If you need access, ask an administrator to add the hr_head role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const audit = await caller.getExecutiveAudit();

  return (
    <AppShell
      title="Executive audit"
      isAdmin={isAdmin}
      roles={session.roles}
      active="exec-audit"
      user={sessionUserChip(session)}
    >
      <ExecAuditClient audit={audit} />
    </AppShell>
  );
}
