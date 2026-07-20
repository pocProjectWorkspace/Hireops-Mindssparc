import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { SystemSetupClient } from "./SystemSetupClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin System Setup (AD14 / AD15) — honest operational config.
 *
 * Two tabs only:
 *   - Email Alerts: enable + recipients + alert types, over the REAL email
 *     path (Resend behind config). Persisted to tenants.settings.systemSetup.
 *   - Escalation Rules (simple): days-threshold → recipient → severity. A
 *     deterministic recipient/severity config, NOT the full tenant-configurable
 *     SLA-threshold table — the SLA hours stay hardcoded in
 *     @hireops/sla-thresholds (Phase-3 deferred). The SLA engine is untouched.
 *
 * The prototype's Job Portals (sourcing connector) and Analytics/Widgets tabs
 * are DEFERRED — not built here.
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the getSystemSetup /
 * updateSystemSetup procedures (server-side admin role).
 */
export default async function SystemSetupPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getSystemSetup({});

  return (
    <AppShell title="System setup" isAdmin active="system-setup" user={sessionUserChip(session)}>
      <SystemSetupClient initial={initial} />
    </AppShell>
  );
}
