import { redirect } from "next/navigation";
import { loadLandingHref } from "@/lib/tenant-ui-settings";

/**
 * Root route. Authenticated → the tenant's landing page for the user's role
 * (systemSetup.landingPages, default /dashboard — the DASH-01 persona
 * landing); otherwise → /login. The middleware also redirects unauthenticated
 * traffic, but this gives logged-in users a direct landing experience without
 * the extra hop.
 */
export default async function RootPage() {
  const landing = await loadLandingHref();
  if (landing) redirect(landing);
  redirect("/login");
}
