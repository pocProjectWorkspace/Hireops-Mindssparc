/**
 * Integration Health screen — admin role only.
 *
 * Wave 1 surfaces only the Workday sync outbox. Real-time updates not
 * required; React Query default refetchInterval (none) means the page
 * stays whatever it loaded with until the user navigates back or the
 * tab regains focus. A future ticket can add a poll if recruiters
 * complain.
 *
 * Layout:
 *   - top banner: SIMULATED mode (amber, not red — this is expected
 *     state, not an error)
 *   - summary tiles
 *   - main list (inline accordion expand for payload + simulated_response)
 *   - filter chips (status / event_type)
 */

import { requireAdmin } from "@/lib/auth";
import { IntegrationsClient } from "./IntegrationsClient";

export default async function IntegrationsPage() {
  await requireAdmin();
  return <IntegrationsClient />;
}
