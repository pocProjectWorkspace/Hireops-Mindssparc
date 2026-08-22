/**
 * Public candidate-facing AI first-round interview (N4.3b).
 *
 * Mounted at /interviews/ai/[token]. Middleware allowlist (PUBLIC_PREFIXES)
 * skips auth — the signed token IS the credential, exactly as it is for
 * /interviews/confirm/[token]. A thin server component delegating to the
 * client that walks the round.
 */

import { AiInterviewClient } from "./AiInterviewClient";

export default function AiInterviewPage({ params }: { params: { token: string } }) {
  return <AiInterviewClient token={params.token} />;
}
