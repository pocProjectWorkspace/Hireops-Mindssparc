import { redirect } from "next/navigation";
import { getOptionalSession } from "@/lib/auth";

/**
 * Root route. Authenticated → /triage; otherwise → /login.
 * The middleware also redirects unauthenticated traffic, but this
 * gives logged-in users a direct landing experience without the extra
 * hop.
 */
export default async function RootPage() {
  const session = await getOptionalSession();
  if (session) redirect("/triage");
  redirect("/login");
}
