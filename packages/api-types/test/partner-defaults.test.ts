import { describe, expect, it } from "vitest";
import {
  defaultPartnerDefaults,
  partnerDefaultsSchema,
  resolvePartnerDefaults,
  updatePartnerDefaultsInputSchema,
} from "../src/partner-defaults";

/**
 * A3 — tenant partner defaults (tenants.settings.partnerDefaults).
 *
 * Honesty focus: this block is the ONLY source of the partner claim window for
 * an org with no live MSA — the router's `PARTNER_CLAIM_WINDOW_DAYS = 90`
 * constant is gone and the schema default below is the single 90 left. So the
 * two properties worth pinning are (a) an unconfigured/corrupt tenant still
 * gets exactly 90 days, byte-identical to the constant it replaced, and (b) the
 * resolver never throws — it runs inside partnerSubmitCandidate's transaction
 * and must never be the reason a submission fails.
 *
 * Pure (no DB) — the MSA-wins-over-default precedence is exercised by the api
 * partner-commercials suite against a live database.
 */

describe("resolvePartnerDefaults", () => {
  it("an unconfigured tenant resolves to the historical 90-day window", () => {
    expect(defaultPartnerDefaults()).toEqual({ claimWindowDays: 90 });
    expect(resolvePartnerDefaults({})).toEqual({ claimWindowDays: 90 });
    expect(resolvePartnerDefaults(undefined)).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults(null)).toEqual(defaultPartnerDefaults());
  });

  it("a configured window round-trips", () => {
    expect(resolvePartnerDefaults({ claimWindowDays: 45 })).toEqual({ claimWindowDays: 45 });
    expect(resolvePartnerDefaults({ claimWindowDays: 1 })).toEqual({ claimWindowDays: 1 });
    expect(resolvePartnerDefaults({ claimWindowDays: 365 })).toEqual({ claimWindowDays: 365 });
  });

  it("a malformed block falls back to the default rather than throwing", () => {
    // Out of range, wrong type, non-integer, and a non-object — every one of
    // these is a claim window a submission would otherwise compute from.
    expect(resolvePartnerDefaults({ claimWindowDays: 0 })).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults({ claimWindowDays: 366 })).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults({ claimWindowDays: -30 })).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults({ claimWindowDays: 30.5 })).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults({ claimWindowDays: "30" })).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults("nonsense")).toEqual(defaultPartnerDefaults());
    expect(resolvePartnerDefaults(90)).toEqual(defaultPartnerDefaults());
  });

  it("unknown sibling keys are dropped, not carried through", () => {
    expect(resolvePartnerDefaults({ claimWindowDays: 60, feePercent: 12 })).toEqual({
      claimWindowDays: 60,
    });
  });
});

describe("partnerDefaultsSchema (the write path)", () => {
  it("rejects an out-of-range window on input rather than clamping it", () => {
    expect(updatePartnerDefaultsInputSchema.safeParse({ claimWindowDays: 0 }).success).toBe(false);
    expect(updatePartnerDefaultsInputSchema.safeParse({ claimWindowDays: 366 }).success).toBe(
      false,
    );
    expect(updatePartnerDefaultsInputSchema.safeParse({ claimWindowDays: 7.5 }).success).toBe(
      false,
    );
    expect(updatePartnerDefaultsInputSchema.safeParse({ claimWindowDays: 120 }).success).toBe(true);
  });

  it("an empty write is valid and means 'the default window'", () => {
    expect(partnerDefaultsSchema.parse({})).toEqual({ claimWindowDays: 90 });
  });
});
