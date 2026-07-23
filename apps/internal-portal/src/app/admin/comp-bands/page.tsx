import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { CompBandsClient } from "./CompBandsClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Comp bands (T3.2 / G15) — the compensation-band library.
 *
 * A tenant's comp-band library is REAL config that drives requisition creation:
 * the requisition wizard's comp-band picker reads this managed, non-archived
 * list, and picking a band POPULATES the position's comp min/max/currency — which
 * the deterministic comp-rules verdict engine + feasibility/detail views already
 * read. Not a decorative dropdown. The position keeps comp_band_id as provenance,
 * so an edit to the filled values reads as a divergence from the linked band.
 *
 * Gated to the WRITE roles (admin + hr_head) — mirrors how business-units gates
 * with requireAdmin, but allows hr_head too. Double-gated: this redirect AND the
 * write procedures (createCompBand / updateCompBand / setCompBandArchived enforce
 * the admin/hr_head roles server-side). Server-prefetches the full list
 * (including archived) so the surface lands populated.
 */
export default async function CompBandsPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const initial = await caller.listCompBands({ includeArchived: true });

  return (
    <AppShell title="Comp bands" isAdmin active="comp-bands" user={sessionUserChip(session)}>
      <CompBandsClient initial={initial} />
    </AppShell>
  );
}
