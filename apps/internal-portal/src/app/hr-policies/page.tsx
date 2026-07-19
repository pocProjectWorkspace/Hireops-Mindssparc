import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { HrPoliciesView } from "@/components/hr-policies/HrPoliciesView";

export const dynamic = "force-dynamic"; // Auth-gated.

/**
 * HROPS-03 — Templates & policies. The curated, read-only HR reference library
 * (offer templates, benefits, people policies), seeded via db:seed:hr-policies
 * and clearly labelled "Curated reference content" in the UI.
 * hr_ops + admin only (HR_OPS_DOC_ROLES).
 */

const ALLOWED_ROLES = ["hr_ops", "admin"];

export default async function HrPoliciesPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => ALLOWED_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Policies"
        isAdmin={isAdmin}
        roles={session.roles}
        active="hr-policies"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="The policy library isn't available for your role"
          hint="This surface is for HR operations. If you need access, ask an administrator to update your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listHrPolicies();

  return (
    <AppShell
      title="Policies"
      isAdmin={isAdmin}
      roles={session.roles}
      active="hr-policies"
      user={sessionUserChip(session)}
    >
      <HrPoliciesView initial={initial} />
    </AppShell>
  );
}
