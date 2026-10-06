import type { Metadata } from "next";
import { TRPCProvider } from "@/components/TRPCProvider";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { DevBanner } from "@/components/DevBanner";
import { TenantBrandingProvider } from "@/components/nav/TenantBrandingProvider";
import { loadChromeBranding } from "@/lib/tenant-branding";
import { ScreeningScoreProvider } from "@/components/ScreeningScoreProvider";
import { loadScreeningScoreVisible } from "@/lib/tenant-ui-settings";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "HireOps Internal Portal",
  description: "Recruiter triage and pipeline operations.",
};

/**
 * BRAND-1: the signed-in tenant's branding is resolved HERE — the one server
 * module that wraps every surface and that no client component imports, so the
 * server-only loader (and @hireops/db behind it) never reaches a browser
 * bundle. One cached query per request; `null` for signed-out visitors (the
 * login page, the public apply routes) and for tenants with no branding
 * configured, which is what keeps the default chrome unchanged.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [branding, screeningScoreVisible] = await Promise.all([
    loadChromeBranding(),
    loadScreeningScoreVisible(),
  ]);

  return (
    <html lang="en">
      <body>
        <RootErrorBoundary>
          <TRPCProvider>
            <TenantBrandingProvider branding={branding}>
              <ScreeningScoreProvider visible={screeningScoreVisible}>
                {children}
              </ScreeningScoreProvider>
            </TenantBrandingProvider>
            <DevBanner />
          </TRPCProvider>
        </RootErrorBoundary>
      </body>
    </html>
  );
}
