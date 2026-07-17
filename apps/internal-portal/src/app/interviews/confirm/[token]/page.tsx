/**
 * Public candidate-facing interview-confirm page (INT-02).
 *
 * Mounted at /interviews/confirm/[token]. Middleware allowlist
 * (PUBLIC_PREFIXES) skips auth — the token IS the credential. Mirrors
 * /offer/[token]: a thin server component delegating to a client that
 * previews the round and posts the confirmation.
 */

import { InterviewConfirmClient } from "./InterviewConfirmClient";

export default function InterviewConfirmPage({ params }: { params: { token: string } }) {
  return <InterviewConfirmClient token={params.token} />;
}
