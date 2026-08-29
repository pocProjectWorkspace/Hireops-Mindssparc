"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChromeBranding } from "@/lib/tenant-branding";

/**
 * BRAND-1 — carries the signed-in tenant's branding from the root layout
 * (where it is resolved server-side, once per request) down to the chrome.
 *
 * WHY A CLIENT CONTEXT rather than the sidebar fetching for itself: AppShell.tsx
 * is pulled into the CLIENT bundle — OnboardingJourney ("use client") imports
 * the nav constants from it — so AppShell's module graph must stay free of
 * server-only code. Importing the branding loader there would drag @hireops/db
 * into a browser bundle. Resolving in app/layout.tsx (a server module nothing
 * client-side imports) and handing the plain, serialisable result across this
 * provider keeps that boundary intact, and has two bonuses: the value is
 * already present when loading.tsx skeletons render, so navigation never
 * flashes one wordmark then the other, and it costs one query per request.
 *
 * `null` = no signed-in tenant, or a tenant with no branding configured →
 * consumers render today's HireOps chrome unchanged.
 */
const TenantBrandingContext = createContext<ChromeBranding | null>(null);

export function TenantBrandingProvider({
  branding,
  children,
}: {
  branding: ChromeBranding | null;
  children: ReactNode;
}) {
  return (
    <TenantBrandingContext.Provider value={branding}>{children}</TenantBrandingContext.Provider>
  );
}

export function useTenantBranding(): ChromeBranding | null {
  return useContext(TenantBrandingContext);
}
