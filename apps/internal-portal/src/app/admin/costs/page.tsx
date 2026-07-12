import { requireAdmin } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { PortalHeader } from "@/components/nav/PortalHeader";
import { CostsClient } from "./CostsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads the live AI usage ledger.

/**
 * Admin AI-cost dashboard — "every Anthropic call logged with tokens and
 * cost, per feature, per model; procurement gets a real TCO number" (demo
 * Act 3, step 16).
 *
 * Admin-gated (requireAdmin redirects non-admins to /triage). Server-
 * prefetches the all-time rollup via the in-process tRPC caller so the
 * screen lands with data; the client CostsClient renders summary tiles,
 * per-feature / per-model tables and a 14-day bar list. USD only —
 * cost_micros is USD micros.
 */
export default async function CostsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getAiUsageSummary({});

  return (
    <main className="flex min-h-screen flex-col">
      <PortalHeader title="AI Cost" isAdmin active="costs" />
      <CostsClient initial={initial} />
    </main>
  );
}
