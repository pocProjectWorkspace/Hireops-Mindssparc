import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { BusinessUnitsClient } from "./BusinessUnitsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Business units (T3.1 / G14) — the org-structure management surface.
 *
 * A tenant's intra-tenant business-unit hierarchy is REAL config that drives
 * requisition creation: the requisition wizard's picker reads this managed,
 * non-archived list, so the human creator chooses a unit from here rather than
 * typing free text. This page is where an admin creates units (with an optional
 * parent), renames them (name only — the slug is immutable so positions keep
 * their FK), reparents them (cycle-guarded server-side), and archives/unarchives
 * them (archiving retires a unit from the picker without breaking positions on it).
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the write procedures
 * (createBusinessUnit / renameBusinessUnit / reparentBusinessUnit /
 * setBusinessUnitArchived enforce the admin role server-side). Server-prefetches
 * the full list (including archived) so the tree lands populated.
 */
export default async function BusinessUnitsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listBusinessUnits({ includeArchived: true });

  return (
    <AppShell
      title="Business units"
      isAdmin
      active="business-units"
      user={sessionUserChip(session)}
    >
      <BusinessUnitsClient initial={initial} />
    </AppShell>
  );
}
