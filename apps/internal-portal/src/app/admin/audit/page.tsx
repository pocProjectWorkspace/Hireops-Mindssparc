import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { AuditClient } from "./AuditClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads the live audit log.

/**
 * Admin audit-trail surface — "every agent action, proposed / approved /
 * sent, logged with the reasoning" (demo Act 3, step 15).
 *
 * Admin-gated (requireAdmin redirects non-admins to /triage). Server-
 * prefetches page 1 of the audit log via the in-process tRPC caller so the
 * screen lands with data; the client AuditClient owns filter chips, inline
 * expand, and Load-more paging off nextCursor.
 */
export default async function AuditPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listAuditEvents({ limit: 50 });

  return (
    <AppShell title="Audit Trail" isAdmin active="audit" user={sessionUserChip(session)}>
      <AuditClient initial={initial} />
    </AppShell>
  );
}
