import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
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
    <AppShell title="AI Cost" isAdmin active="costs" user={sessionUserChip(session)}>
      <CostsClient initial={initial} />
    </AppShell>
  );
}
