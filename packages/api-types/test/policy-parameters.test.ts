import { describe, expect, it } from "vitest";
import {
  AI_INTERVIEW_POLICY_GUARDRAILS,
  MARKET_INTEL_POLICY_GUARDRAILS,
  NOTETAKER_KEYTERMS_MAX,
  OFFER_POLICY_GUARDRAILS,
  REPORT_POLICY_GUARDRAILS,
  REQ_HEALTH_WEIGHTS_DEFAULT,
  SCREENING_POLICY_GUARDRAILS,
  UPLOAD_DOCUMENT_BYTES_CEILING,
  aiInterviewPolicyWriteSchema,
  clampPolicyNumber,
  defaultAiInterviewPolicy,
  defaultMarketIntelPolicy,
  defaultNotetakerPolicy,
  defaultOfferPolicy,
  defaultReportPolicy,
  defaultScreeningPolicy,
  defaultUploadPolicy,
  describeTimeToFill,
  marketGapPercentLabel,
  notetakerPolicyWriteSchema,
  offerPolicyWriteSchema,
  reportPolicyWriteSchema,
  resolveAiInterviewPolicy,
  resolveMarketIntelPolicy,
  resolveNotetakerPolicy,
  resolveOfferPolicy,
  resolveReportPolicy,
  resolveScreeningPolicy,
  resolveUploadPolicy,
  screeningPolicyWriteSchema,
  updatePolicyParametersInputSchema,
  uploadMimeTypes,
  uploadPolicyWriteSchema,
} from "../src/policy-parameters";
import { TENANT_SETTINGS_BLOCK_KEYS, isJsonSubset, settingsBlockDef } from "../src/tenant-config";

/**
 * C2-F7 — policy parameters (Plan A §8). Per block: (1) defaults are the
 * literals the code used before, (2) a partial override keeps the rest at
 * default, (3) out-of-range numbers are CLAMPED to the platform guardrail,
 * (4) garbage falls back to defaults and never throws. Plus: the strict write
 * schemas accept every default and reject out-of-range input, and every block
 * rides the config export/import allowlist.
 */

const GARBAGE: unknown[] = [undefined, null, 42, "x", [], true];

describe("clampPolicyNumber", () => {
  const g = { min: 1, max: 10, default: 5 };
  it("clamps, rounds integers, and defaults non-numbers", () => {
    expect(clampPolicyNumber(0, g)).toBe(1);
    expect(clampPolicyNumber(99, g)).toBe(10);
    expect(clampPolicyNumber(3.6, g)).toBe(4);
    expect(clampPolicyNumber(3.6, g, false)).toBe(3.6);
    expect(clampPolicyNumber(Number.NaN, g)).toBe(5);
    expect(clampPolicyNumber("7", g)).toBe(5);
  });
});

describe("screeningPolicy", () => {
  it("defaults are the historical literals", () => {
    const d = defaultScreeningPolicy();
    expect(d).toEqual({
      riskSkillMismatchMaxPct: 50,
      riskSalaryRule: "over_band_max",
      riskSalaryCompaRatioPct: 110,
      reqHealthWeights: REQ_HEALTH_WEIGHTS_DEFAULT,
      parserConfidenceFloor: 0.5,
      jdCharCap: 12_000,
      dedupMatchOn: "email_or_phone",
      reapplyCoolingOffDays: 0,
      acceptingStatuses: ["approved", "posted"],
    });
    for (const g of GARBAGE) expect(resolveScreeningPolicy(g)).toEqual(d);
    expect(screeningPolicyWriteSchema.safeParse(d).success).toBe(true);
  });

  it("a partial override keeps every other field at default", () => {
    const r = resolveScreeningPolicy({ jdCharCap: 8000, dedupMatchOn: "email" });
    expect(r.jdCharCap).toBe(8000);
    expect(r.dedupMatchOn).toBe("email");
    expect(r.parserConfidenceFloor).toBe(0.5);
    expect(r.acceptingStatuses).toEqual(["approved", "posted"]);
  });

  it("out-of-range numbers are clamped to the guardrail", () => {
    const r = resolveScreeningPolicy({
      riskSkillMismatchMaxPct: 400,
      riskSalaryCompaRatioPct: 10,
      parserConfidenceFloor: 5,
      jdCharCap: 1_000_000,
      reapplyCoolingOffDays: -3,
    });
    expect(r.riskSkillMismatchMaxPct).toBe(100);
    expect(r.riskSalaryCompaRatioPct).toBe(SCREENING_POLICY_GUARDRAILS.riskSalaryCompaRatioPct.min);
    expect(r.parserConfidenceFloor).toBe(0.9);
    expect(r.jdCharCap).toBe(24_000);
    expect(r.reapplyCoolingOffDays).toBe(0);
  });

  it("garbage fields fall back field by field", () => {
    const r = resolveScreeningPolicy({
      riskSalaryRule: "vibes",
      dedupMatchOn: 3,
      acceptingStatuses: ["draft", "closed"],
      reqHealthWeights: { jd: 90 }, // does not total 100 → default profile
      jdCharCap: 5000,
    });
    expect(r.riskSalaryRule).toBe("over_band_max");
    expect(r.dedupMatchOn).toBe("email_or_phone");
    expect(r.acceptingStatuses).toEqual(["approved", "posted"]);
    expect(r.reqHealthWeights).toEqual(REQ_HEALTH_WEIGHTS_DEFAULT);
    expect(r.jdCharCap).toBe(5000);
  });

  it("acceptingStatuses never admits a non-live status and de-duplicates", () => {
    expect(
      resolveScreeningPolicy({ acceptingStatuses: ["posted", "draft", "posted"] })
        .acceptingStatuses,
    ).toEqual(["posted"]);
    expect(
      screeningPolicyWriteSchema.safeParse({ ...defaultScreeningPolicy(), acceptingStatuses: [] })
        .success,
    ).toBe(false);
  });

  it("write schema: weights must total 100", () => {
    const bad = {
      ...defaultScreeningPolicy(),
      reqHealthWeights: { ...REQ_HEALTH_WEIGHTS_DEFAULT, jd: 25 },
    };
    expect(screeningPolicyWriteSchema.safeParse(bad).success).toBe(false);
    const good = {
      ...defaultScreeningPolicy(),
      reqHealthWeights: { ...REQ_HEALTH_WEIGHTS_DEFAULT, jd: 25, pipeline: 5 },
    };
    expect(screeningPolicyWriteSchema.safeParse(good).success).toBe(true);
    expect(resolveScreeningPolicy(good).reqHealthWeights.jd).toBe(25);
  });
});

describe("uploadPolicy", () => {
  it("defaults = the platform ceiling, deployment media cap, every type", () => {
    const d = defaultUploadPolicy();
    expect(d).toEqual({
      maxDocumentBytes: UPLOAD_DOCUMENT_BYTES_CEILING,
      maxMediaBytes: null,
      resumeTypes: ["pdf", "docx"],
      documentTypes: ["pdf", "docx", "jpeg", "png"],
    });
    for (const g of GARBAGE) expect(resolveUploadPolicy(g)).toEqual(d);
    expect(uploadPolicyWriteSchema.safeParse(d).success).toBe(true);
  });

  it("a tenant may only lower the document cap (clamped above to the ceiling)", () => {
    expect(resolveUploadPolicy({ maxDocumentBytes: 50 * 1024 * 1024 }).maxDocumentBytes).toBe(
      UPLOAD_DOCUMENT_BYTES_CEILING,
    );
    expect(resolveUploadPolicy({ maxDocumentBytes: 5 * 1024 * 1024 }).maxDocumentBytes).toBe(
      5 * 1024 * 1024,
    );
    expect(resolveUploadPolicy({ maxDocumentBytes: 10 }).maxDocumentBytes).toBe(1024 * 1024);
    expect(
      uploadPolicyWriteSchema.safeParse({ ...defaultUploadPolicy(), maxDocumentBytes: 11 << 20 })
        .success,
    ).toBe(false);
  });

  it("type lists keep only known kinds; empty → default", () => {
    expect(resolveUploadPolicy({ resumeTypes: ["pdf", "exe"] }).resumeTypes).toEqual(["pdf"]);
    expect(resolveUploadPolicy({ resumeTypes: ["exe"] }).resumeTypes).toEqual(["pdf", "docx"]);
    expect(uploadMimeTypes(["pdf"]).has("application/pdf")).toBe(true);
  });
});

describe("offerPolicy", () => {
  it("defaults 7 d expiry, 3 m probation, 24 h decision SLA", () => {
    expect(defaultOfferPolicy()).toEqual({
      defaultExpiryDays: 7,
      defaultProbationMonths: 3,
      decisionSlaHours: 24,
    });
    for (const g of GARBAGE) expect(resolveOfferPolicy(g)).toEqual(defaultOfferPolicy());
  });
  it("partial + clamp", () => {
    expect(resolveOfferPolicy({ defaultExpiryDays: 14 })).toEqual({
      ...defaultOfferPolicy(),
      defaultExpiryDays: 14,
    });
    const r = resolveOfferPolicy({
      defaultExpiryDays: 600,
      defaultProbationMonths: 99,
      decisionSlaHours: 0,
    });
    expect(r.defaultExpiryDays).toBe(OFFER_POLICY_GUARDRAILS.defaultExpiryDays.max);
    expect(r.defaultProbationMonths).toBe(24);
    expect(r.decisionSlaHours).toBe(1);
    expect(
      offerPolicyWriteSchema.safeParse({ ...defaultOfferPolicy(), defaultExpiryDays: 61 }).success,
    ).toBe(false);
  });
});

describe("aiInterviewPolicy", () => {
  it("defaults 7 d link, 5–10 questions, English", () => {
    expect(defaultAiInterviewPolicy()).toEqual({
      linkExpiryDays: 7,
      questionCountMin: 5,
      questionCountMax: 10,
      language: "en",
    });
    for (const g of GARBAGE)
      expect(resolveAiInterviewPolicy(g)).toEqual(defaultAiInterviewPolicy());
  });
  it("the 5–10 range is the platform guardrail; an inverted pair collapses", () => {
    const r = resolveAiInterviewPolicy({
      questionCountMin: 2,
      questionCountMax: 40,
      linkExpiryDays: 90,
    });
    expect(r.questionCountMin).toBe(AI_INTERVIEW_POLICY_GUARDRAILS.questionCountMin.min);
    expect(r.questionCountMax).toBe(10);
    expect(r.linkExpiryDays).toBe(30);
    const inv = resolveAiInterviewPolicy({ questionCountMin: 9, questionCountMax: 6 });
    expect(inv).toMatchObject({ questionCountMin: 6, questionCountMax: 6 });
    expect(resolveAiInterviewPolicy({ language: "fr" }).language).toBe("en");
    expect(
      aiInterviewPolicyWriteSchema.safeParse({
        ...defaultAiInterviewPolicy(),
        questionCountMin: 9,
        questionCountMax: 6,
      }).success,
    ).toBe(false);
  });
});

describe("notetakerPolicy", () => {
  it("defaults to English, no glossary", () => {
    expect(defaultNotetakerPolicy()).toEqual({ language: "en", keyterms: [] });
    for (const g of GARBAGE) expect(resolveNotetakerPolicy(g)).toEqual(defaultNotetakerPolicy());
  });
  it("keyterms are trimmed, de-duplicated, length/word-limited and capped", () => {
    const r = resolveNotetakerPolicy({
      keyterms: [" P2P ", "p2p", "R2R", 7, "", "one two three four five six seven", "x".repeat(61)],
    });
    expect(r.keyterms).toEqual(["P2P", "R2R"]);
    const many = Array.from({ length: 80 }, (_, i) => `term${i}`);
    expect(resolveNotetakerPolicy({ keyterms: many }).keyterms).toHaveLength(
      NOTETAKER_KEYTERMS_MAX,
    );
    expect(notetakerPolicyWriteSchema.safeParse({ language: "en", keyterms: many }).success).toBe(
      false,
    );
  });
});

describe("reportPolicy", () => {
  it("defaults are the semantic layer's historical definitions", () => {
    expect(defaultReportPolicy()).toEqual({
      hireEvent: "offer_accepted",
      ttfStart: "application_created",
      ttfEnd: "offer_accepted",
      requisitionAgingRowCap: 500,
      onboardingRowCap: 200,
      onboardingWindowDays: 14,
    });
    for (const g of GARBAGE) expect(resolveReportPolicy(g)).toEqual(defaultReportPolicy());
  });
  it("partial, clamp, garbage", () => {
    const r = resolveReportPolicy({
      ttfStart: "requisition_approved",
      ttfEnd: "nope",
      requisitionAgingRowCap: 1e9,
      onboardingWindowDays: 0,
    });
    expect(r.ttfStart).toBe("requisition_approved");
    expect(r.ttfEnd).toBe("offer_accepted");
    expect(r.requisitionAgingRowCap).toBe(REPORT_POLICY_GUARDRAILS.requisitionAgingRowCap.max);
    expect(r.onboardingWindowDays).toBe(1);
    expect(
      reportPolicyWriteSchema.safeParse({ ...defaultReportPolicy(), onboardingWindowDays: 91 })
        .success,
    ).toBe(false);
  });
  it("describeTimeToFill follows the definition", () => {
    expect(describeTimeToFill(defaultReportPolicy())).toBe(
      "days from application to its accepted offer",
    );
    expect(describeTimeToFill({ ttfStart: "requisition_approved", ttfEnd: "joined" })).toBe(
      "days from requisition approval to the hire's joining date",
    );
  });
});

describe("marketIntelPolicy", () => {
  it("default 0.9, clamp 0.5–1, garbage → default", () => {
    expect(defaultMarketIntelPolicy()).toEqual({ gapThreshold: 0.9 });
    for (const g of GARBAGE)
      expect(resolveMarketIntelPolicy(g)).toEqual(defaultMarketIntelPolicy());
    expect(resolveMarketIntelPolicy({ gapThreshold: 0.8 }).gapThreshold).toBe(0.8);
    expect(resolveMarketIntelPolicy({ gapThreshold: 3 }).gapThreshold).toBe(1);
    expect(resolveMarketIntelPolicy({ gapThreshold: 0.1 }).gapThreshold).toBe(
      MARKET_INTEL_POLICY_GUARDRAILS.gapThreshold.min,
    );
    expect(marketGapPercentLabel(0.9)).toBe("10%");
    expect(marketGapPercentLabel(0.8)).toBe("20%");
  });
});

describe("updatePolicyParametersInputSchema", () => {
  it("routes by block and validates the value strictly", () => {
    expect(
      updatePolicyParametersInputSchema.safeParse({
        block: "offerPolicy",
        value: defaultOfferPolicy(),
      }).success,
    ).toBe(true);
    expect(
      updatePolicyParametersInputSchema.safeParse({
        block: "offerPolicy",
        value: { ...defaultOfferPolicy(), decisionSlaHours: 0 },
      }).success,
    ).toBe(false);
    expect(
      updatePolicyParametersInputSchema.safeParse({ block: "ai_provider", value: "openai" })
        .success,
    ).toBe(false);
  });
});

describe("config export/import allowlist", () => {
  const blocks: [string, unknown][] = [
    ["screeningPolicy", defaultScreeningPolicy()],
    ["uploadPolicy", defaultUploadPolicy()],
    ["offerPolicy", defaultOfferPolicy()],
    ["aiInterviewPolicy", defaultAiInterviewPolicy()],
    ["notetakerPolicy", { language: "en", keyterms: ["P2P", "SAP S/4HANA"] }],
    ["reportPolicy", { ...defaultReportPolicy(), ttfEnd: "joined" }],
    ["marketIntelPolicy", { gapThreshold: 0.85 }],
  ];
  it.each(blocks)("%s is exportable and survives its own resolver", (key, value) => {
    expect(TENANT_SETTINGS_BLOCK_KEYS).toContain(key);
    const def = settingsBlockDef(key);
    expect(def).toBeDefined();
    expect(isJsonSubset(value, def?.normalize(value))).toBe(true);
  });
  it("ai_provider is never in the allowlist (platform-controlled)", () => {
    expect(TENANT_SETTINGS_BLOCK_KEYS).not.toContain("ai_provider");
  });
});
