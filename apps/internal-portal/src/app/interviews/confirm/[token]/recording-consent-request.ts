/**
 * N2b — how the candidate confirm page asks the API to write consent.
 *
 * The two builders below are the only place a consent field is put on the
 * wire, and they live in their own module for one reason: the rule they
 * encode ("silence is not consent") is the compliance-critical half of this
 * screen, and here it is a pure function that a test can pin. The portal's
 * vitest harness is node-only and cannot import a `.tsx`, so logic left
 * inside the component is logic nothing can assert on.
 */

/** What the candidate picked at confirm time; null = they did not answer. */
export type ConsentChoice = "granted" | "declined" | null;

/** The two decisions the recording-consent route accepts after confirmation. */
export type ConsentChange = "granted" | "withdrawn";

/**
 * The request for POST /api/interviews/confirm/:token.
 *
 * Returns a bare `{ method: "POST" }` — NO BODY AT ALL, exactly what this page
 * sent before N2b — whenever the round was never flagged for recording or the
 * candidate did not answer. The API reads an absent `recordingConsent` as "no
 * consent row at all", which is the only honest reading of silence: a
 * candidate who was never asked, or who ignored the question, has consented to
 * nothing and must not be stored as having answered either way.
 */
export function confirmRequestInit(input: {
  recordingRequested: boolean;
  choice: ConsentChoice;
}): RequestInit {
  if (!input.recordingRequested || input.choice === null) return { method: "POST" };
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordingConsent: input.choice === "granted" }),
  };
}

/**
 * The request for POST /api/interviews/confirm/:token/recording-consent.
 *
 * 'declined' is not a value this route takes: it answers "may we?", which is a
 * confirm-time question. Once answered, a candidate grants or withdraws — and
 * the route is deliberately not single-use, so either can be sent repeatedly.
 */
export function consentChangeRequestInit(decision: ConsentChange): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  };
}
