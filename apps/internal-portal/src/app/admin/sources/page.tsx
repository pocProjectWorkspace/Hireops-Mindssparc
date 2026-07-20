import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { SourcesClient } from "./SourcesClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Sources (T1.1 / G04) — the sourcing-channel registry.
 *
 * The platform pools candidates, but `application_source` is a FIXED enum:
 * every tenant shares the same taxonomy and an org had NO way to declare WHICH
 * channels it uses, what to CALL them, or to turn one off. This page is that
 * config surface — one row per channel, keyed to the canonical enum value, with
 * a display label, an enabled toggle, an honest ingestion-mode flag (a
 * configured channel is NOT a live auto-pull; connectors are a deferred work
 * package), and an optional per-channel detail (career-site slug, mailbox, …).
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the write procedures
 * (upsertTenantSource / setTenantSourceEnabled enforce the admin role server-
 * side). Server-prefetches the registry so the table lands populated.
 */
export default async function SourcesPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listTenantSources({});

  return (
    <AppShell title="Sources" isAdmin active="sources" user={sessionUserChip(session)}>
      <SourcesClient initial={initial} />
    </AppShell>
  );
}
