import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { ReportsHubClient } from "./ReportsHubClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live requisition/application data.

/**
 * R0.2 — the /reports catalog surface.
 *
 * One page, one filter bar, many reports: the point of the catalog is
 * that every report resolves "this period, this business unit, this
 * recruiter" through the SAME server-side semantic layer, instead of each
 * analytics surface hand-rolling its own WHERE clauses. Two reports ship
 * here — requisition status & aging, and recruiter productivity, the two
 * the reporting build plan rates as genuinely missing. The existing
 * persona surfaces (/metrics, /insights, /hr-analytics, /admin/reports)
 * are untouched; they re-home into this catalog in a later ticket.
 *
 * Gated to admin + hr_head + hr_ops, matching the REPORTS_READ_ROLES set
 * on both procedures. A direct hit by another role gets a calm in-shell
 * notice rather than a bare 403. Both reports are server-prefetched
 * unfiltered so the page lands with data and the default view costs no
 * client fetch.
 */

const READ_ROLES = ["admin", "hr_head", "hr_ops"];

export default async function ReportsHubPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Reports"
        isAdmin={isAdmin}
        roles={session.roles}
        active="reports-catalog"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Reports isn't available for your role"
          hint="The reporting catalog is for HR leadership, HR operations and administrators. If you need access, ask an administrator to add the hr_head or hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const [initialAging, initialProductivity] = await Promise.all([
    caller.getRequisitionAgingReport({}),
    caller.getRecruiterProductivityReport({}),
  ]);

  return (
    <AppShell
      title="Reports"
      isAdmin={isAdmin}
      roles={session.roles}
      active="reports-catalog"
      user={sessionUserChip(session)}
    >
      <ReportsHubClient initialAging={initialAging} initialProductivity={initialProductivity} />
    </AppShell>
  );
}
