import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { BrandingClient } from "./BrandingClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Theme & Branding (AD2) — the per-tenant branding surface.
 *
 * The company display name here writes the real `tenants.display_name`
 * COLUMN — the field that actually rebrands the product (the candidate-facing
 * chrome reads it as `tenantDisplayName`). The NovaChem rebrand used to be a
 * raw SQL UPDATE of exactly this column with no surface; this page turns it
 * into a real, demoable feature. The cosmetic trio (primary colour, logo URL,
 * dark-mode default) persists to `tenants.settings.branding` via an atomic
 * jsonb merge that preserves every sibling settings key.
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the procedures
 * themselves (getTenantBranding / updateTenantBranding enforce the admin role
 * server-side). Server-prefetches the effective branding so the form + live
 * preview land populated.
 */
export default async function BrandingPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const branding = await caller.getTenantBranding({});

  return (
    <AppShell title="Theme & branding" isAdmin active="branding" user={sessionUserChip(session)}>
      <BrandingClient initial={branding} />
    </AppShell>
  );
}
