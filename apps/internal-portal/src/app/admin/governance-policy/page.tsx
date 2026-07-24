import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { GovernancePolicyClient } from "./GovernancePolicyClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin governance policy (T4.2) — the compliance-score weights + governance SLA
 * knobs config surface.
 *
 * The compliance-score weights and the governance SLA thresholds (approval-SLA
 * days, feedback-SLA hours, unrealistic-must-have threshold) lived ONLY in code
 * constants (COMPLIANCE_WEIGHTS / REQUISITION_APPROVAL_SLA_DAYS / FEEDBACK_SLA_HOURS
 * / UNREALISTIC_MUST_HAVE_THRESHOLD). This page lets a tenant tune them. The saved
 * policy is REAL config: it drives the executive-audit compliance score, and the
 * deterministic governance risk flags (overdue approvals, unrealistic must-haves,
 * overdue feedback). An unconfigured tenant resolves to the code defaults, so it
 * behaves exactly as before.
 *
 * Gated to {admin, hr_head} — governance is HR-head territory alongside admin.
 * Double-gated: this redirect AND the get/updateGovernancePolicy procedures
 * (GOVERNANCE_READ_ROLES) enforce the same roles server-side.
 */
export default async function GovernancePolicyPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getGovernancePolicy({});

  return (
    <AppShell
      title="Governance policy"
      isAdmin
      active="governance-policy"
      user={sessionUserChip(session)}
    >
      <GovernancePolicyClient initial={initial} />
    </AppShell>
  );
}
