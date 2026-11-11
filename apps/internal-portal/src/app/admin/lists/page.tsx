import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { ListsClient } from "./ListsClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Lists (C1-F3 — Plan A §4 "Shape"): the tenant's values over the
 * platform default lists (employment / requisition types, hold, decline, renege
 * and separation reasons, asset types). Readable by admin + hr_head (read-only
 * for hr_head); writes are admin-only, enforced server-side.
 */
export default async function ListsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  if (!isAdmin && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listTenantLookups({});

  return (
    <AppShell title="Lists" isAdmin active="lists" user={sessionUserChip(session)}>
      <ListsClient initial={initial} canEdit={isAdmin} />
    </AppShell>
  );
}
