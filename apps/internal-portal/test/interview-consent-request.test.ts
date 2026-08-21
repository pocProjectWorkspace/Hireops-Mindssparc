import { describe, expect, it } from "vitest";
import {
  confirmRequestInit,
  consentChangeRequestInit,
} from "../src/app/interviews/confirm/[token]/recording-consent-request";

/**
 * N2b — what the candidate confirm page puts on the wire for recording
 * consent. The rule being pinned is the one the API cannot enforce for us:
 * ABSENCE IS NOT PERMISSION, so a round nobody asked to record, and a
 * candidate who did not answer, must send no consent field at all rather than
 * a `false` that would store a decline the candidate never made.
 *
 * DB-free, render-free — the portal harness is node-only (it cannot even parse
 * a `.tsx`), which is why these builders are a module of their own.
 */

/** The parsed JSON body, or undefined when no body was sent. */
function bodyOf(init: RequestInit): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : undefined;
}

describe("confirmRequestInit (silence is not consent)", () => {
  it("sends NO body when the round was never flagged for recording", () => {
    const init = confirmRequestInit({ recordingRequested: false, choice: null });
    expect(init).toEqual({ method: "POST" });
    expect(bodyOf(init)).toBeUndefined();
  });

  it("sends NO body when the candidate confirms without answering", () => {
    const init = confirmRequestInit({ recordingRequested: true, choice: null });
    expect(init).toEqual({ method: "POST" });
    expect(bodyOf(init)).toBeUndefined();
  });

  it("never leaks a choice made before the ask was withdrawn", () => {
    // Defence in depth: recordingRequested is the outer gate, so even a stale
    // selection cannot write a consent row for an unrecorded round.
    expect(bodyOf(confirmRequestInit({ recordingRequested: false, choice: "granted" }))).toBe(
      undefined,
    );
  });

  it("sends recordingConsent: true when the candidate grants", () => {
    const init = confirmRequestInit({ recordingRequested: true, choice: "granted" });
    expect(init.method).toBe("POST");
    expect(bodyOf(init)).toEqual({ recordingConsent: true });
  });

  it("sends recordingConsent: false when the candidate declines", () => {
    // A decline is an ANSWER, not silence — it must be stored as one.
    const init = confirmRequestInit({ recordingRequested: true, choice: "declined" });
    expect(bodyOf(init)).toEqual({ recordingConsent: false });
  });
});

describe("consentChangeRequestInit (the withdrawal path)", () => {
  it("posts decision 'withdrawn' when the candidate takes consent back", () => {
    const init = consentChangeRequestInit("withdrawn");
    expect(init.method).toBe("POST");
    expect(bodyOf(init)).toEqual({ decision: "withdrawn" });
  });

  it("posts decision 'granted' when a candidate who refused changes their mind", () => {
    expect(bodyOf(consentChangeRequestInit("granted"))).toEqual({ decision: "granted" });
  });
});
