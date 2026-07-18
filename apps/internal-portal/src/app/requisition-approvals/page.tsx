import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PageHeader } from "@/components/patterns";
import { RequisitionApprovalsTable } from "@/components/requisitions/RequisitionApprovalsTable";

export const dynamic = "force-dynamic"; // Auth-gated + reads live approval state.

/**
 * REQ-01 → HRHEAD-01 — the HR-head requisition-approval queue.
 *
 * Server-rendered over the enriched listRequisitionApprovals rows (title, dept,
 * budget band, requester name, age, priority, outcome). HRHEAD-01 upgrades the
 * bare skeleton to a PageHeader + filter-tabbed full table; a row opens the
 * existing decision view on the requisition detail page (approve / send back /
 * reject live there and inline on the HR-head dashboard).
 *
 * Persona-gated to hr_head / admin: the nav only surfaces it to those roles and
 * the API enforces the same set (recruiter/hiring_manager get FORBIDDEN). A
 * direct hit by another role gets a calm in-shell notice.
 */

const READ_ROLES = ["hr_head", "admin"];

export default async function RequisitionApprovalsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Req approvals"
        isAdmin={isAdmin}
        roles={session.roles}
        active="requisition-approvals"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Requisition approvals isn't available for your role"
          hint="This queue is for the HR head. If you need access, ask an administrator to add the hr_head role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const { rows } = await caller.listRequisitionApprovals({ limit: 100 });

  return (
    <AppShell
      title="Req approvals"
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisition-approvals"
      user={sessionUserChip(session)}
    >
      <div className="mx-auto w-full max-w-6xl space-y-6 px-8 py-6">
        <PageHeader
          title="Requisition approvals"
          subtitle="Review submitted requisitions and decide — approve, send back, or reject. Open a row for the full requisition and decision panel."
        />
        <RequisitionApprovalsTable rows={rows} />
      </div>
    </AppShell>
  );
}
