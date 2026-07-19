import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { InsightsClient } from "./InsightsClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live pipeline / scorecards.

/**
 * RO-03 — /insights.
 *
 * Per-requisition analytics for the hiring manager (with an "all my reqs"
 * rollup): a KPI strip, hiring funnel with drop-off, candidate score
 * distribution, skill-gap analysis, salary-band-vs-curated-benchmark, SLA &
 * bottleneck tiles, and panel-feedback trends. Every figure is a real,
 * deterministic query. Time-to-hire is a HISTORICAL AVERAGE, never a
 * prediction. NO psychometric radar, NO offer-acceptance probability, NO
 * AI-recommendation block — deliberate refusals.
 *
 * hiring_manager + admin (nav + API enforce the same). Scoped to my reqs.
 */

const READ_ROLES = ["hiring_manager", "admin"];

export default async function InsightsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Insights"
        isAdmin={isAdmin}
        roles={session.roles}
        active="insights"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Insights isn't available for your role"
          hint="This surface is for hiring managers. If you need access, ask an administrator to add the hiring_manager role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.getRequisitionInsights({});

  return (
    <AppShell
      title="Insights"
      isAdmin={isAdmin}
      roles={session.roles}
      active="insights"
      user={sessionUserChip(session)}
    >
      <InsightsClient initial={initial} />
    </AppShell>
  );
}
