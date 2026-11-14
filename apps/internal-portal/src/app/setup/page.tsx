import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { SetupWizardClient } from "./SetupWizardClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant state.

/**
 * C1-F11 — the basic tenant setup wizard (Plan A §14.3 steps 3–4). Tenant
 * admins only (requireAdmin here; every procedure re-checks the admin role).
 * Each step links to the existing admin pages; go-live completes onboarding
 * when the required checklist passes.
 */
export default async function SetupPage() {
  const session = await requireAdmin("settings.tenant_config");
  const caller = createServerTRPCCaller(session);
  const setup = await caller.getTenantSetup({});
  return (
    <AppShell title="Tenant setup" isAdmin active="tenant-setup" user={sessionUserChip(session)}>
      <SetupWizardClient initial={setup} />
    </AppShell>
  );
}
