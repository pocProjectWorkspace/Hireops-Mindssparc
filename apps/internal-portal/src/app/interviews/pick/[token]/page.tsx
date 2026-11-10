/**
 * PC-9 — public pick-a-time page, mounted at /interviews/pick/[token].
 * Middleware allowlists the prefix: the signed token IS the credential.
 */

import { PickSlotClient } from "./PickSlotClient";

export default function PickSlotPage({ params }: { params: { token: string } }) {
  return <PickSlotClient token={params.token} />;
}
