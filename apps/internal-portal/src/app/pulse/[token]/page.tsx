/**
 * PC-14 — public pre-joining check-in page, reached from the "Answer the
 * check-in" button in a pulse / two-weeks-to-go email.
 *
 * Mounted at /pulse/[token]; middleware PUBLIC_PREFIXES lets it through. The
 * signed token IS the credential (matched server-side to its touchpoint).
 */

import { PulseClient } from "./PulseClient";

export default function PulsePage({ params }: { params: { token: string } }) {
  return <PulseClient token={params.token} />;
}
