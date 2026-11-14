import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { PolicyParametersClient } from "./PolicyParametersClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin policy parameters (C2-F7 / Plan A §8) — the remaining hard-coded policy
 * numbers as tenant settings: screening (risk flags, requisition-health
 * weights, parser floor, JD cap, dedup, accepting statuses), uploads (incl. the
 * bulk-CV caps), offers, AI interview, notetaker, report definitions and the
 * market-gap rule. Each section saves its own tenants.settings block through
 * updatePolicyParameters (admin-only, audited). Values are bounded by platform
 * guardrails the API enforces; the AI provider is shown read-only.
 *
 * Gated twice on `settings.system` (C2-F1): requireAdmin("settings.system")
 * here AND requireCapability in get/updatePolicyParameters.
 */
export default async function PolicyParametersPage() {
  const session = await requireAdmin("settings.system");
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getPolicyParameters({});
  return (
    <AppShell title="Policy parameters" active="policy-parameters" user={sessionUserChip(session)}>
      <PolicyParametersClient initial={initial} />
    </AppShell>
  );
}
