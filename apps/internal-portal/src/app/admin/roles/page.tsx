import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PageContainer } from "@/components/nav/PageContainer";
import { RolesAdminClient } from "./RolesAdminClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant roles.

/**
 * C2-F1 — Roles & permissions. The platform's system roles (read-only: their
 * permissions follow the platform default) and the tenant's CUSTOM roles: a
 * label + base role + a bundle of capabilities, each with a target scope where
 * the capability has one. Assign a role to a member on Users & roles.
 *
 * Double-gated: requireAdmin("admin.roles") here AND every roles procedure on
 * the API. Every write is audited (withAudit + the table audit trigger).
 */
export default async function RolesAdminPage() {
  const session = await requireAdmin("admin.roles");
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listRoles({});
  return (
    <AppShell title="Roles & permissions" isAdmin active="roles" user={sessionUserChip(session)}>
      <PageContainer>
        <RolesAdminClient initial={initial} />
      </PageContainer>
    </AppShell>
  );
}
