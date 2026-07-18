import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { UsersAdminClient } from "./UsersAdminClient";
import { RetentionSection } from "./RetentionSection";

export const dynamic = "force-dynamic"; // Admin-gated + reads live memberships.

/**
 * Admin users & roles (CONF-03) — the tenant-membership governance surface:
 * list members, edit internal roles, deactivate/reactivate, and invite a new
 * member (no email this ticket — the temp password is shown once). Plus a
 * read-only Data-retention reference section (ONBOARD-01 document_types).
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the procedures
 * themselves (every list/mutation enforces the admin role server-side). The
 * membership writes run through the service-role pool because
 * tenant_user_memberships carries no authenticated write policy.
 */
export default async function UsersAdminPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const [users, retention] = await Promise.all([
    caller.listTenantUsersAdmin({}),
    caller.getDocumentRetention({}),
  ]);

  return (
    <AppShell title="Users & roles" isAdmin active="users" user={sessionUserChip(session)}>
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <UsersAdminClient initialUsers={users.items} />
        <RetentionSection items={retention.items} />
      </div>
    </AppShell>
  );
}
