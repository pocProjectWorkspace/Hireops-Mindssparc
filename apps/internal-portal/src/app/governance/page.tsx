import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { RetentionSection } from "@/app/admin/users/RetentionSection";
import { GovernanceClient } from "./GovernanceClient";
import { RiskFlagsPanel } from "./RiskFlagsPanel";

export const dynamic = "force-dynamic"; // Role-gated + reads live tenant config + data.

/**
 * HRHEAD-03 — Policy & Governance (persona pass 3/3).
 *
 * The HR head's configuration surface: the two settings blocks (screening
 * privacy anonymisation, candidate feedback sharing), the active risk-flag
 * panel, and the read-only retention reference. Every control is consumed by
 * real code paths — nothing here is cosmetic. The "changes require admin
 * approval" note is honest copy: for the POC an hr_head edit takes effect
 * immediately (no approval workflow was built).
 *
 * hr_head + admin only, enforced twice (page notice + the procedures).
 */

const READ_ROLES = ["hr_head", "admin"];

export default async function GovernancePage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Governance"
        isAdmin={isAdmin}
        roles={session.roles}
        active="governance"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Governance isn't available for your role"
          hint="Policy & Governance is for the HR head. If you need access, ask an administrator to add the hr_head role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const [screeningPrivacy, feedbackSharing, risk, retention] = await Promise.all([
    caller.getScreeningPrivacy({}),
    caller.getFeedbackSharing({}),
    caller.getGovernanceRiskFlags(),
    caller.getDocumentRetention({}),
  ]);

  return (
    <AppShell
      title="Governance"
      isAdmin={isAdmin}
      roles={session.roles}
      active="governance"
      user={sessionUserChip(session)}
    >
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <p className="mb-6 max-w-prose text-sm text-neutral-600">
          Bias Shield anonymisation and candidate feedback-sharing policy. These controls are
          consumed by real code paths: screening privacy shapes what recruiters see in triage;
          feedback sharing shapes what candidates see of their interviews.
        </p>
        <GovernanceClient
          initialScreeningPrivacy={screeningPrivacy}
          initialFeedbackSharing={feedbackSharing}
        />
        <RiskFlagsPanel risk={risk} />
        <RetentionSection items={retention.items} />
      </div>
    </AppShell>
  );
}
