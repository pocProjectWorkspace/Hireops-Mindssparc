"use client";

import { BrandGlyph } from "./BrandGlyph";
import { useTenantBranding } from "./TenantBrandingProvider";

/**
 * BRAND-1 — the contents of the sidebar's brand block.
 *
 * Renders the SIGNED-IN TENANT's branding when they have configured any
 * (logo from `settings.branding.logoUrl`, name from `tenants.display_name`),
 * and today's HireOps mark + wordmark otherwise — an unconfigured tenant, and
 * every pre-session render, is byte-identical to what shipped.
 *
 * The white plate behind a tenant logo is deliberate. Tenant logos are drawn
 * for light grounds (the demo tenant's is near-black navy on transparent), and
 * the sidebar brand block is slate-ink — the same trap BrandGlyph.tsx exists to
 * solve for our own mark. Seating an arbitrary tenant logo on white is the only
 * treatment that is legible for every tenant without per-tenant tuning.
 *
 * When a logo is set we do NOT also print the display name: a supplied logo is
 * almost always a full lockup (mark + company name), so the name would read
 * twice. It still reaches assistive tech as the image's alt text. A tenant with
 * branding but no logo gets our glyph plus their name as text.
 *
 * The wrapper (border, padding, dark background) stays in AppShell so this
 * component's default branch is exactly the two elements that were there
 * before.
 */
export function BrandWordmark() {
  const branding = useTenantBranding();

  if (branding?.logoUrl) {
    return (
      <span className="flex min-w-0 items-center rounded-md bg-white px-2 py-1">
        {/* Plain <img>, not next/image: the tenant-supplied URL is arbitrary
            and off-domain, which next/image rejects without a remotePatterns
            entry per tenant. */}
        <img
          src={branding.logoUrl}
          alt={branding.displayName}
          className="h-6 w-auto max-w-[8.5rem] object-contain"
        />
      </span>
    );
  }

  if (branding) {
    return (
      <>
        <BrandGlyph size={28} className="shrink-0 text-white" />
        <span className="truncate text-base font-semibold tracking-tight text-sidebar-fg">
          {branding.displayName}
        </span>
      </>
    );
  }

  return (
    <>
      <BrandGlyph size={28} className="shrink-0 text-white" />
      <span className="text-base font-semibold tracking-tight text-sidebar-fg">HireOps</span>
    </>
  );
}
