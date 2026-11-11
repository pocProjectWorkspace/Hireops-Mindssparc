import { describe, expect, it } from "vitest";
import {
  CLAIM_EXPIRY_WARNING_DAYS_MAX,
  PARTNER_CONSENT_VERSION,
  PLATFORM_CLAIM_EXPIRY_WARNING_DAYS,
  effectiveOfferStatus,
  normalisePhone,
  partnerOwnershipAttestation,
  phoneMatchKeys,
  resolveClaimExpiryWarningDays,
  resolvePartnerDefaults,
  resolveTenantDefaultCountry,
  sourceLabelOverrides,
  summariseBenchmarkSources,
  upsertMarketBenchmarkInputSchema,
} from "../src/index";

/**
 * C1-BUGS — the pure halves of BUG-5 (phone), BUG-7 (source relabels), BUG-8
 * (partner attestation), BUG-9 (claim warning lead time), BUG-10 (offer
 * expiry on read) and BUG-15 (benchmark sources). No DB.
 */

describe("BUG-5 normalisePhone — E.164 with the person/tenant country", () => {
  it("+91 and a bare 10-digit number in India normalise to the same value", () => {
    const withCc = normalisePhone("+91 98765 43210", "IN");
    const bare = normalisePhone("9876543210", "IN");
    expect(withCc).toBe("+919876543210");
    expect(bare).toBe("+919876543210");
  });

  it("an explicit + prefix wins over the country (no double country code)", () => {
    expect(normalisePhone("+44 7911 123456", "IN")).toBe("+447911123456");
    expect(normalisePhone("0044 7911 123456", "IN")).toBe("+447911123456");
  });

  it("international digits typed without '+' are recognised", () => {
    expect(normalisePhone("919876543210", "IN")).toBe("+919876543210");
    expect(normalisePhone("447911123456", "GB")).toBe("+447911123456");
  });

  it("a national trunk 0 is dropped", () => {
    expect(normalisePhone("07911 123456", "GB")).toBe("+447911123456");
    expect(normalisePhone("09876543210", "IN")).toBe("+919876543210");
  });

  it("no country known → digits only (never a hard-coded +91)", () => {
    expect(normalisePhone("98765 43210")).toBe("9876543210");
    expect(normalisePhone("98765 43210", null)).toBe("9876543210");
    expect(normalisePhone("98765 43210", "ZZ")).toBe("9876543210");
  });

  it("empty / non-digit input → empty", () => {
    expect(normalisePhone("   ")).toBe("");
    expect(normalisePhone("n/a", "IN")).toBe("");
  });

  it("lookup keys include the legacy digits-only forms", () => {
    expect(phoneMatchKeys("+919876543210").sort()).toEqual(
      ["+919876543210", "919876543210", "9876543210"].sort(),
    );
    expect(phoneMatchKeys("9876543210")).toEqual(["9876543210", "+9876543210"]);
    expect(phoneMatchKeys("")).toEqual([]);
  });

  it("tenant default country comes from settings.defaultCountry; no platform default", () => {
    expect(resolveTenantDefaultCountry({ defaultCountry: "in" })).toBe("IN");
    expect(resolveTenantDefaultCountry({ defaultCountry: "XX" })).toBeNull();
    expect(resolveTenantDefaultCountry({})).toBeNull();
    expect(resolveTenantDefaultCountry(null)).toBeNull();
    expect(resolveTenantDefaultCountry("nonsense")).toBeNull();
  });
});

describe("BUG-7 sourceLabelOverrides", () => {
  it("maps every relabelled source, enabled or not, and skips blank labels", () => {
    expect(
      sourceLabelOverrides([
        { sourceEnum: "partner_empanelled", label: "RPO (Hudson)" },
        { sourceEnum: "job_board", label: " Naukri " },
        { sourceEnum: "referral", label: "  " },
      ]),
    ).toEqual({ partner_empanelled: "RPO (Hudson)", job_board: "Naukri" });
  });
});

describe("BUG-9 claimExpiryWarningDays", () => {
  it("defaults to the platform value for an unconfigured tenant", () => {
    expect(resolvePartnerDefaults({})).toEqual({
      claimWindowDays: 90,
      claimExpiryWarningDays: PLATFORM_CLAIM_EXPIRY_WARNING_DAYS,
    });
    expect(resolveClaimExpiryWarningDays({})).toBe(PLATFORM_CLAIM_EXPIRY_WARNING_DAYS);
    expect(resolveClaimExpiryWarningDays(null)).toBe(PLATFORM_CLAIM_EXPIRY_WARNING_DAYS);
  });

  it("reads the tenant override from the whole settings jsonb", () => {
    expect(resolveClaimExpiryWarningDays({ partnerDefaults: { claimExpiryWarningDays: 7 } })).toBe(
      7,
    );
  });

  it("a malformed warning value falls back without resetting the window", () => {
    expect(resolvePartnerDefaults({ claimWindowDays: 45, claimExpiryWarningDays: 0 })).toEqual({
      claimWindowDays: 45,
      claimExpiryWarningDays: PLATFORM_CLAIM_EXPIRY_WARNING_DAYS,
    });
    expect(
      resolvePartnerDefaults({
        claimWindowDays: 45,
        claimExpiryWarningDays: CLAIM_EXPIRY_WARNING_DAYS_MAX + 1,
      }).claimExpiryWarningDays,
    ).toBe(PLATFORM_CLAIM_EXPIRY_WARNING_DAYS);
  });
});

describe("BUG-8 partner ownership attestation", () => {
  it("states the configured window and scope, not 'MSA §4.2 … 90-day'", () => {
    const text = partnerOwnershipAttestation(
      { claimWindowDays: 60, exclusivityScope: "req_only", source: "msa" },
      "Acme",
    );
    expect(text).toContain("60-day exclusivity window");
    expect(text).toContain("for this requisition only");
    expect(text).toContain("agreement with Acme");
    expect(text).not.toMatch(/4\.2|Section|90-day/);
  });

  it("org-wide tenant default reads as such", () => {
    const text = partnerOwnershipAttestation(
      { claimWindowDays: 120, exclusivityScope: "org_wide", source: "tenant_default" },
      "Acme",
    );
    expect(text).toContain("120-day exclusivity window (across all Acme requisitions)");
    expect(text).toContain("under Acme's partner terms");
  });

  it("the attestation wording version was bumped past v1", () => {
    expect(PARTNER_CONSENT_VERSION).not.toBe("partner-msa-v1-2026-05");
    expect(PARTNER_CONSENT_VERSION).toMatch(/^partner-msa-v2-/);
  });
});

describe("BUG-10 effectiveOfferStatus", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  it("an extended offer past its expiry reads as expired", () => {
    expect(effectiveOfferStatus("extended", "2026-11-10T12:00:00Z", now)).toBe("expired");
    expect(effectiveOfferStatus("extended", new Date("2026-11-11T12:00:00Z"), now)).toBe("expired");
  });
  it("an extended offer before expiry, and every other status, is unchanged", () => {
    expect(effectiveOfferStatus("extended", "2026-11-12T12:00:00Z", now)).toBe("extended");
    expect(effectiveOfferStatus("accepted", "2026-11-01T00:00:00Z", now)).toBe("accepted");
    expect(effectiveOfferStatus("drafted", "2026-11-01T00:00:00Z", now)).toBe("drafted");
    expect(effectiveOfferStatus("extended", null, now)).toBe("extended");
    expect(effectiveOfferStatus("extended", "not a date", now)).toBe("extended");
  });
});

describe("BUG-15 benchmark source summary", () => {
  it("names nothing when no source is recorded (no invented label)", () => {
    expect(summariseBenchmarkSources([])).toEqual({ kind: "none" });
    expect(summariseBenchmarkSources([{ sourceNote: " " }])).toEqual({ kind: "none" });
  });
  it("one source → named; several → counted", () => {
    expect(
      summariseBenchmarkSources([{ sourceNote: "Survey A" }, { sourceNote: "Survey A" }]),
    ).toEqual({ kind: "single", note: "Survey A" });
    expect(
      summariseBenchmarkSources([{ sourceNote: "Survey A" }, { sourceNote: "Survey B" }]),
    ).toEqual({ kind: "multiple", count: 2 });
  });
  it("the upsert requires a source note (no 'update quarterly' default)", () => {
    const base = {
      roleTitle: "Analyst",
      medianSalaryMinor: 1,
      ttfDays: 30,
      availability: "low",
      competitorDemand: "low",
      recommendedRounds: 2,
    };
    expect(upsertMarketBenchmarkInputSchema.safeParse(base).success).toBe(false);
    expect(upsertMarketBenchmarkInputSchema.safeParse({ ...base, sourceNote: "  " }).success).toBe(
      false,
    );
    expect(
      upsertMarketBenchmarkInputSchema.safeParse({ ...base, sourceNote: "Survey A" }).success,
    ).toBe(true);
  });
});
