import { redirect } from "next/navigation";
import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { OrganisationClient } from "./OrganisationClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Organisation (C1-F3 — Plan A F3, §15 P1/P2).
 *
 * Readable by admin + hr_head (hr_head sees it read-only); every write is
 * admin-only and is enforced server-side as well. Server-prefetches the full
 * organisation + job architecture (inactive rows included) so the page lands
 * populated.
 */
export default async function OrganisationPage() {
  const session = await requireAuth();
  if (!sessionCan(session, "organisation.read")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getOrgAndJobArchitecture({ includeInactive: true });

  return (
    <AppShell title="Organisation" isAdmin active="organisation" user={sessionUserChip(session)}>
      <OrganisationClient initial={initial} canEdit={sessionCan(session, "organisation.write")} />
    </AppShell>
  );
}
