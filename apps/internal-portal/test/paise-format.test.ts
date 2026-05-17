import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

/**
 * Display-layer paise → INR formatter. Lives inline in two callers
 * (OfferSection + OfferAcceptClient + the email template); the local
 * copies have to agree on lakh/crore grouping (`en-IN` Intl locale).
 *
 * The function under test is the inline implementation; we re-declare
 * it here rather than export from a component file. If a future ticket
 * extracts the formatter to a shared util, point this test at that.
 */
function formatPaiseAsInr(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

describe("Module 4 paise → INR formatter", () => {
  it("formats lakh-range amounts with Indian grouping", () => {
    assert.equal(formatPaiseAsInr(4_200_000 * 100), "₹42,00,000");
  });

  it("formats sub-lakh amounts", () => {
    assert.equal(formatPaiseAsInr(50_000 * 100), "₹50,000");
  });

  it("rounds half-paise up", () => {
    assert.equal(formatPaiseAsInr(150), "₹2"); // 150 paise → 1.5 → 2
  });

  it("handles crore-scale", () => {
    // 25 crore = 250,000,000 INR = 25,000,000,000 paise. Indian grouping
    // emits "25,00,00,000" (lakh / crore notation).
    assert.equal(formatPaiseAsInr(250_000_000 * 100), "₹25,00,00,000");
  });
});
