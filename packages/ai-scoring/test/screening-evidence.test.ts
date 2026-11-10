/**
 * PC-6 — evidence-based screening, the PURE half: criteria, CV text, quote
 * verification, verdict downgrade, the deterministic sort key, and the prompt
 * (full JD — PP6; no protected attributes; CV block extraction under masking).
 * No DB, no AI.
 */

import { describe, expect, it } from "vitest";
import type { ParserOutput } from "@hireops/ai-client";
// Direct module import: the @hireops/ai-client barrel pulls in @hireops/db.
import { maskPii } from "../../ai-client/src/pii-mask";
import {
  AI_SCORING_PROMPT_VERSION,
  JD_CHAR_CAP,
  aiScoringResponseSchema,
  buildAIScoringPrompt,
  buildScreeningCriteria,
  compareScreeningSummaries,
  composeScreeningJd,
  countScreeningVerdicts,
  extractCvBlock,
  isVerbatimQuote,
  jdRequirementsFromMetadata,
  reconcileScreeningEvidence,
  renderCvForScreening,
  screeningSortKey,
  type RawScreeningCriterion,
  type ScreeningCriterion,
} from "../src";

const CV: ParserOutput = {
  personal: {
    full_name: "Priya Raman",
    email: "priya.raman@example.com",
    phone: "+91 98450 12345",
    location_city: "Pune",
    location_country: "India",
    linkedin_url: "https://linkedin.com/in/priya",
    github_url: null,
    portfolio_url: null,
  },
  summary: "Chartered accountant with 8 years in month-end close and IFRS reporting.",
  total_years_experience: 8,
  current_role: {
    title: "Finance Manager",
    company: "Acme Chemicals",
    start_date: "2021-04",
    location: "Pune",
    description: null,
  },
  work_history: [
    {
      title: "Finance Manager",
      company: "Acme Chemicals",
      start_date: "2021-04",
      end_date: null,
      location: "Pune",
      description:
        "Led the month-end close for 3 entities using SAP S/4HANA.\nOwned intercompany reconciliations.",
      employment_type: "full_time",
    },
  ],
  education: [
    {
      degree: "B.Com",
      field_of_study: "Accounting",
      institution: "Pune University",
      start_year: 2010,
      end_year: 2013,
      grade: null,
    },
  ],
  skills: {
    technical: ["SAP S/4HANA", "Excel"],
    languages: ["Marathi", "English"],
    certifications: [{ name: "Chartered Accountant", issuer: "ICAI", year: 2015 }],
    domain: ["IFRS"],
  },
  notice_period_days: 60,
  expected_compensation: { amount: 2500000, currency: "INR", period: "annual" },
  parse_metadata: {
    parser_version: "1.0.0",
    parsed_at: "2026-11-01T00:00:00.000Z",
    confidence_score: 0.9,
    source_format: "docx",
    parser_model: "local",
  },
};

const CRITERIA: ScreeningCriterion[] = [
  { key: "mh-1", kind: "must_have", label: "SAP" },
  { key: "mh-2", kind: "must_have", label: "IFRS" },
  { key: "rq-1", kind: "requirement", label: "CA qualification" },
];

/** Index into an array, failing loudly instead of a non-null assertion. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected an element at index ${i}`);
  return v;
}

function raw(
  key: string,
  verdict: RawScreeningCriterion["verdict"],
  quotes: string[],
): RawScreeningCriterion {
  return { criterion_key: key, verdict, reason: `Reason for ${key}.`, quotes };
}

describe("buildScreeningCriteria", () => {
  it("takes required skills (in order) then JD requirement lines, de-duplicated", () => {
    const out = buildScreeningCriteria({
      jdSkills: [
        { skillName: "SAP", weight: 1, isRequired: true },
        { skillName: "Power BI", weight: 0.5, isRequired: false },
        { skillName: " IFRS ", weight: 0.8, isRequired: true },
      ],
      jdRequirements: ["• CA qualification", "ifrs", "  ", "5+ years in month-end close"],
    });
    expect(out).toEqual([
      { key: "mh-1", kind: "must_have", label: "SAP" },
      { key: "mh-2", kind: "must_have", label: "IFRS" },
      { key: "rq-1", kind: "requirement", label: "CA qualification" },
      { key: "rq-2", kind: "requirement", label: "5+ years in month-end close" },
    ]);
  });

  it("reads requirements defensively from jd_versions.ai_metadata", () => {
    expect(jdRequirementsFromMetadata(null)).toEqual([]);
    expect(jdRequirementsFromMetadata({ sections: { requirements: "x" } })).toEqual([]);
    expect(jdRequirementsFromMetadata({ sections: { requirements: ["a", 3, " ", "b"] } })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("renderCvForScreening — no contact details or protected-attribute proxies", () => {
  const text = renderCvForScreening(CV);
  it("carries the job-relevant content", () => {
    expect(text).toContain("Led the month-end close for 3 entities using SAP S/4HANA.");
    expect(text).toContain("Chartered Accountant (ICAI, 2015)");
    expect(text).toContain("Domain skills: IFRS");
  });
  it("omits name, contact, location, spoken languages and compensation", () => {
    for (const absent of [
      "Priya",
      "priya.raman@example.com",
      "98450",
      "linkedin",
      "Marathi",
      "India",
      "2500000",
    ]) {
      expect(text).not.toContain(absent);
    }
  });
});

describe("quote verification (shared verbatim matcher)", () => {
  const text = renderCvForScreening(CV);
  it("accepts verbatim spans across whitespace / case / typographic differences", () => {
    expect(isVerbatimQuote("led the month-end close  for 3 entities", text)).toBe(true);
    expect(isVerbatimQuote("“Led the month–end close for 3 entities”", text)).toBe(true);
  });
  it("rejects paraphrase and joined spans", () => {
    expect(isVerbatimQuote("Led month-end close for three entities", text)).toBe(false);
    expect(isVerbatimQuote("Led the month-end close … intercompany reconciliations", text)).toBe(
      false,
    );
  });
});

describe("reconcileScreeningEvidence — verdict downgrade", () => {
  const cvText = renderCvForScreening(CV);

  it("keeps a met verdict with a verified quote", () => {
    const r = reconcileScreeningEvidence({
      raw: [raw("mh-1", "met", ["using SAP S/4HANA"])],
      criteria: CRITERIA.slice(0, 1),
      cvText,
    });
    expect(r.criteria[0]).toMatchObject({
      key: "mh-1",
      verdict: "met",
      quotes: ["using SAP S/4HANA"],
    });
    expect(r.quotesDropped).toBe(0);
    expect(r.downgraded).toBe(0);
  });

  it("drops a fabricated quote and downgrades met → unclear when nothing verified remains", () => {
    const r = reconcileScreeningEvidence({
      raw: [raw("mh-2", "met", ["Prepared consolidated IFRS statements for 12 entities"])],
      criteria: [at(CRITERIA, 1)],
      cvText,
    });
    expect(at(r.criteria, 0).verdict).toBe("unclear");
    expect(at(r.criteria, 0).quotes).toEqual([]);
    expect(at(r.criteria, 0).reason).toMatch(/could be verified/);
    expect(r.quotesDropped).toBe(1);
    expect(r.downgraded).toBe(1);
  });

  it("partially_met with only unverifiable quotes is also downgraded; a verified one survives", () => {
    const r = reconcileScreeningEvidence({
      raw: [
        raw("mh-1", "partially_met", ["SAP ECC 6.0 rollout"]),
        raw("mh-2", "partially_met", ["IFRS reporting", "made up line"]),
      ],
      criteria: CRITERIA.slice(0, 2),
      cvText,
    });
    expect(at(r.criteria, 0).verdict).toBe("unclear");
    expect(at(r.criteria, 1).verdict).toBe("partially_met");
    expect(at(r.criteria, 1).quotes).toEqual(["IFRS reporting"]);
    expect(r.quotesDropped).toBe(2);
  });

  it("not_met without quotes stands; not_met resting on fabricated quotes is downgraded", () => {
    const r = reconcileScreeningEvidence({
      raw: [raw("mh-1", "not_met", []), raw("mh-2", "not_met", ["No IFRS exposure at all"])],
      criteria: CRITERIA.slice(0, 2),
      cvText,
    });
    expect(r.criteria.map((c) => c.verdict)).toEqual(["not_met", "unclear"]);
  });

  it("caps quotes at 2, dedupes, discards unknown/duplicate keys, fills skipped criteria as unclear", () => {
    const r = reconcileScreeningEvidence({
      raw: [
        raw("mh-1", "met", [
          "SAP S/4HANA",
          "sap  s/4hana",
          "Excel",
          "Owned intercompany reconciliations.",
        ]),
        raw("mh-1", "not_met", ["dup"]),
        raw("zz-9", "met", ["Excel"]),
      ],
      criteria: CRITERIA,
      cvText,
    });
    expect(r.criteria.map((c) => c.key)).toEqual(["mh-1", "mh-2", "rq-1"]);
    expect(at(r.criteria, 0).quotes).toEqual(["SAP S/4HANA", "Excel"]);
    expect(at(r.criteria, 1).verdict).toBe("unclear");
    expect(at(r.criteria, 2).verdict).toBe("unclear");
    // dedupe(1) + over-cap(1) on mh-1, the duplicate key(1), the unknown key(1)
    expect(r.quotesDropped).toBe(4);
    expect(r.counts).toEqual({ criteriaCount: 3, met: 1, partiallyMet: 0, notMet: 0, unclear: 2 });
  });
});

describe("deterministic sort key", () => {
  it("met counts 1, partially met ½; then fewer not-met first", () => {
    expect(screeningSortKey({ met: 3, partiallyMet: 1, notMet: 2 })).toEqual([3.5, 2]);
    const rows = [
      { id: "a", s: { met: 2, partiallyMet: 2, notMet: 0 } }, // 3
      { id: "b", s: { met: 3, partiallyMet: 0, notMet: 2 } }, // 3, more not-met
      { id: "c", s: null },
      { id: "d", s: { met: 4, partiallyMet: 0, notMet: 1 } }, // 4
      { id: "e", s: { met: 3, partiallyMet: 0, notMet: 1 } }, // 3, 1 not-met
    ];
    const order = [...rows].sort((x, y) => compareScreeningSummaries(x.s, y.s)).map((r) => r.id);
    expect(order).toEqual(["d", "a", "e", "b", "c"]);
  });

  it("countScreeningVerdicts tallies each verdict", () => {
    expect(
      countScreeningVerdicts([
        { verdict: "met" },
        { verdict: "partially_met" },
        { verdict: "not_met" },
        { verdict: "unclear" },
        { verdict: "met" },
      ]),
    ).toEqual({ criteriaCount: 5, met: 2, partiallyMet: 1, notMet: 1, unclear: 1 });
  });
});

describe("prompt (pc6-v1)", () => {
  const longJd = `${"Own the month-end close. ".repeat(40)}Must hold a CA. TAIL-MARKER`;

  it("sends the FULL JD, not the first 500 chars (PP6), capped at JD_CHAR_CAP", () => {
    expect(longJd.length).toBeGreaterThan(900);
    const { user } = buildAIScoringPrompt({
      positionTitle: "Finance Manager",
      jdDescription: longJd,
      jdSkills: [{ skillName: "SAP", weight: 1, isRequired: true }],
      parsedCv: CV,
      criteria: CRITERIA,
    });
    expect(user).toContain("TAIL-MARKER");
    const huge = "x".repeat(JD_CHAR_CAP + 500);
    expect((composeScreeningJd(huge, null) ?? "").length).toBe(JD_CHAR_CAP);
  });

  it("puts the summary in front when jd_text lacks it", () => {
    expect(composeScreeningJd("# JD body", "Finance lead role.")).toBe(
      "Finance lead role.\n\n# JD body",
    );
    expect(composeScreeningJd("Finance lead role. More.", "Finance lead role.")).toBe(
      "Finance lead role. More.",
    );
  });

  it("lists every criterion by key, forbids protected attributes, carries no contact details", () => {
    const { system, user } = buildAIScoringPrompt({
      positionTitle: "Finance Manager",
      jdDescription: "JD",
      jdSkills: [],
      parsedCv: CV,
      criteria: CRITERIA,
    });
    expect(user).toContain("mh-1 [must-have skill]: SAP");
    expect(user).toContain("rq-1 [required qualification]: CA qualification");
    expect(system).toMatch(/Never consider, infer or mention age, gender/);
    expect(user).not.toContain("priya.raman@example.com");
    expect(user).not.toContain("Marathi");
    expect(AI_SCORING_PROMPT_VERSION).toBe("pc6-v1");
  });

  it("extractCvBlock returns exactly the CV text — and the masked text after PII masking", () => {
    const withPii: ParserOutput = {
      ...CV,
      summary: "Reach me at someone@example.org. Chartered accountant.",
    };
    const { user } = buildAIScoringPrompt({
      positionTitle: "Finance Manager",
      jdDescription: "JD",
      jdSkills: [],
      parsedCv: withPii,
      criteria: CRITERIA,
    });
    expect(extractCvBlock(user)).toBe(renderCvForScreening(withPii));
    const masked = maskPii(user);
    const block = extractCvBlock(masked) ?? "";
    expect(block).toContain("[redacted-email]");
    expect(block).not.toContain("someone@example.org");
  });

  it("response schema: criteria defaults to [] for an older-shaped response", () => {
    const parsed = aiScoringResponseSchema.parse({
      score: 70,
      top_factors: [
        { factor: "skills_match", score: 0.7, note: "ok" },
        { factor: "other", score: 0.5, note: "ok" },
      ],
      caveats: [],
    });
    expect(parsed.criteria).toEqual([]);
  });
});
