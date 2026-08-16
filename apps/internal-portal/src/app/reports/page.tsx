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
 * analytics surface hand-rolling its own WHERE clauses. Requisition aging
 * and recruiter productivity shipped first (the two the reporting build
 * plan rates as genuinely missing), then pipeline & speed (R0.3), then the
 * sponsor pack — headcount vs plan and the approval cycle (R1.1), the
 * partner / agency scorecard (R1.3), and interview & scorecard health plus
 * onboarding readiness (R1.2) — each of which honours a narrower slice
 * of the shared bar and says so on itself.
 * Every report is server-prefetched unfiltered here. The existing
 * persona surfaces (/metrics, /insights, /hr-analytics, /admin/reports)
 * are untouched; they re-home into this catalog in a later ticket.
 *
 * Gated to admin + hr_head + hr_ops, matching the REPORTS_READ_ROLES set
 * every catalog procedure applies. A direct hit by another role gets a
 * calm in-shell notice rather than a bare 403. The prefetch is unfiltered
 * so the page lands with data and the default view costs no client fetch.
 */

const READ_ROLES = ["admin", "hr_head", "hr_ops"];

// R0.4 drill-down gates. The catalog's readers are a WIDER set than either
// drill-down target's, so the links are role-checked here rather than shown
// to everyone and failing on arrival:
//   - /requisitions/[id] reads getRequisitionDetail (REQUISITION_READ_ROLES);
//   - /triage renders off listCandidates (same set) and has no role notice of
//     its own, so hr_ops would land on an error boundary.
// Both mirror the target's gate intersected with this page's readers.
const REQUISITION_DETAIL_ROLES = ["admin", "hr_head", "hiring_manager", "recruiter"];
const TRIAGE_ROLES = ["admin", "hr_head", "hiring_manager", "recruiter"];

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
  const [
    initialAging,
    initialProductivity,
    initialPipeline,
    initialHeadcount,
    initialApprovals,
    initialPartners,
    initialInterviewHealth,
    initialOnboarding,
  ] = await Promise.all([
    caller.getRequisitionAgingReport({}),
    caller.getRecruiterProductivityReport({}),
    caller.getPipelineReport({}),
    caller.getHeadcountVsPlanReport({}),
    caller.getApprovalAnalyticsReport({}),
    caller.getPartnerScorecardReport({}),
    caller.getInterviewHealthReport({}),
    caller.getOnboardingReadinessReport({}),
  ]);

  return (
    <AppShell
      title="Reports"
      isAdmin={isAdmin}
      roles={session.roles}
      active="reports-catalog"
      user={sessionUserChip(session)}
    >
      <ReportsHubClient
        initialAging={initialAging}
        initialProductivity={initialProductivity}
        initialPipeline={initialPipeline}
        initialHeadcount={initialHeadcount}
        initialApprovals={initialApprovals}
        initialPartners={initialPartners}
        initialInterviewHealth={initialInterviewHealth}
        initialOnboarding={initialOnboarding}
        isAdmin={isAdmin}
        canOpenRequisitionDetail={session.roles.some((r) => REQUISITION_DETAIL_ROLES.includes(r))}
        canOpenTriage={session.roles.some((r) => TRIAGE_ROLES.includes(r))}
      />
    </AppShell>
  );
}
