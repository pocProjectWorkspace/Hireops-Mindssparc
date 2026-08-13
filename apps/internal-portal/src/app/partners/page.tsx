import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { PartnersClient } from "./PartnersClient";

export const dynamic = "force-dynamic"; // Auth-gated + reads live partner state.

/**
 * P0.1B — the internal partner-administration index.
 *
 * The staff-side counterpart to the partner portal: every staffing partner in
 * the tenant with its live counts (portal users, active requisition
 * assignments, active ownership claims), plus the empanelment form. Until this
 * surface existed the only way to create a partner org was the seed script.
 *
 * Role-gated to admin / hr_ops — the same PARTNER_ADMIN_ROLES set the eight
 * partner-admin procedures enforce server-side. A direct hit by another role
 * gets a calm in-shell notice rather than a 403 page.
 */

const READ_ROLES = ["admin", "hr_ops"];

export default async function PartnersPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Partners"
        isAdmin={isAdmin}
        roles={session.roles}
        active="partners"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Partner administration isn't available for your role"
          hint="This surface is for administrators and the HR Ops team. If you need access, ask an administrator to add the hr_ops role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listPartnerOrgs();

  return (
    <AppShell
      title="Partners"
      isAdmin={isAdmin}
      roles={session.roles}
      active="partners"
      user={sessionUserChip(session)}
    >
      <PartnersClient initial={initial} />
    </AppShell>
  );
}
