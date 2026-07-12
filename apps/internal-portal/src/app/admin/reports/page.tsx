import { requireAdmin } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { PortalHeader } from "@/components/nav/PortalHeader";
import { ReportsClient } from "./ReportsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live application data.

/**
 * Admin recruitment report — the first reporting surface (requirements
 * §9.8, a deliberate Wave-2 pull-forward for the demo so the "what about
 * reporting?" question gets a live answer instead of a roadmap slide).
 *
 * Admin-gated (requireAdmin redirects non-admins to /triage). Server-
 * prefetches the all-time report via the in-process tRPC caller so the
 * screen lands with data; ReportsClient renders totals tiles, the funnel
 * as horizontal bars, a source-mix table, the time-to-hire trio, and a
 * per-stage duration table. Deliberately basic — counts, medians, and
 * breakdowns; no cohorting, exports, or filters beyond the date range the
 * API reserves for later.
 */
export default async function ReportsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getRecruitmentReport({});

  return (
    <main className="flex min-h-screen flex-col">
      <PortalHeader title="Reports" isAdmin active="reports" />
      <ReportsClient initial={initial} />
    </main>
  );
}
