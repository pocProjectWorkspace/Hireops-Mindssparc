import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { MessagingClient } from "./MessagingClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads the live notification outbox.

/**
 * Admin Messaging (AD12) — an HONEST, email-only surface.
 *
 * The prototype's WhatsApp channel is REFUSED entirely: HireOps has no
 * WhatsApp/SMS integration and no delivery/read receipts, so we don't fake
 * them. What we DO have is real: the notification_outbox (email via Resend
 * behind config) and the code-owned @hireops/email-templates. This page reads
 * the tenant-scoped delivery log and lists the real templates.
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the listNotificationLog
 * procedure (server-side admin role). Server-prefetches the first page so the
 * screen lands with data.
 */
export default async function MessagingPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listNotificationLog({ limit: 100 });

  return (
    <AppShell title="Messaging" isAdmin active="messaging" user={sessionUserChip(session)}>
      <MessagingClient initial={initial} />
    </AppShell>
  );
}
