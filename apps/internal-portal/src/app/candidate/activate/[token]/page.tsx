/**
 * Candidate activation — set-password page (CAND-01).
 *
 * Mounted at /candidate/activate/[token]. Public (middleware allowlist) — the
 * signed link IS the credential. A thin server component delegating to a
 * client that posts completeCandidateActivation and redirects to sign in.
 */

import { CandidateActivateClient } from "./CandidateActivateClient";

export default function CandidateActivatePage({ params }: { params: { token: string } }) {
  return <CandidateActivateClient token={params.token} />;
}
