import { requireAdmin } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
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
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold text-neutral-900">Audit Trail</h1>
          <a href="/triage" className="text-sm text-neutral-500 underline hover:text-neutral-900">
            Triage
          </a>
        </div>
        <a href="/logout" className="text-sm text-neutral-600 underline hover:text-neutral-900">
          Sign out
        </a>
      </header>
      <AuditClient initial={initial} />
    </main>
  );
}
