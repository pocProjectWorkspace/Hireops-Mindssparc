/**
 * Public candidate-facing accept / decline page.
 *
 * Mounted at /offer/[token]. Middleware allowlist (PUBLIC_PREFIXES)
 * skips auth. The token IS the credential.
 *
 * Server component does minimal verification work — it doesn't render
 * the offer summary server-side because the candidate-side API does
 * the name-match enforcement after they confirm their name. The page
 * is therefore one big client component.
 */

import { OfferAcceptClient } from "./OfferAcceptClient";

export default function OfferAcceptPage({ params }: { params: { token: string } }) {
  return <OfferAcceptClient token={params.token} />;
}
