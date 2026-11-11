/**
 * Knockout evaluator unit tests (AI-03).
 *
 * Pure-function tests — no DB, no AI. Covers each KnockoutType, the
 * missing-field / wrong-type null path, all-pass / mixed / all-null
 * verdict resolution, and the source-not-parsed-cv early-out.
 */

import { describe, expect, it } from "vitest";
import { evaluateKnockouts, getByPath, type KnockoutInput } from "../src/knockouts";

const baseCv = {
  personal: {
    location_country: "IN",
    location_city: "Bengaluru",
  },
  total_years_experience: 7,
  notice_period_days: 30,
  skills: {
    technical: ["Java", "Spring Boot", "Kafka"],
    languages: ["English"],
    certifications: [],
    domain: [],
  },
};

const k = (overrides: Partial<KnockoutInput>): KnockoutInput => ({
  id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
  type: overrides.type ?? "boolean",
  source: overrides.source ?? "parsed_cv",
  thresholdValue: overrides.thresholdValue ?? { field_path: "x.y", required: true },
  questionText: overrides.questionText,
});

describe("getByPath", () => {
  it("walks a nested object", () => {
    expect(getByPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });
  it("returns undefined on a missing intermediate key", () => {
    expect(getByPath({ a: {} }, "a.b.c")).toBeUndefined();
  });
  it("returns undefined on null root", () => {
    expect(getByPath(null, "a.b")).toBeUndefined();
  });
  it("does not descend into arrays", () => {
    expect(getByPath({ a: [1, 2, 3] }, "a.0")).toBeUndefined();
  });
});

describe("evaluateKnockouts — boolean", () => {
  it("passes when the boolean value is truthy", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "boolean",
        thresholdValue: { field_path: "skills.technical", required: true },
      }),
    ]);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails (result=false) when the array is empty", () => {
    const r = evaluateKnockouts({ ...baseCv, skills: { ...baseCv.skills, technical: [] } }, [
      k({
        type: "boolean",
        thresholdValue: { field_path: "skills.technical", required: true },
      }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.result).toBe(false);
    expect(r.failures[0]!.reason).toBe("value_falsy");
  });

  it("returns null (not failed) when the field is missing", () => {
    const r = evaluateKnockouts({ personal: {} }, [
      k({
        type: "boolean",
        thresholdValue: { field_path: "skills.technical", required: true },
      }),
    ]);
    expect(r.passed).toBeNull();
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.result).toBeNull();
    expect(r.failures[0]!.reason).toBe("field_missing");
  });
});

describe("evaluateKnockouts — numeric_min", () => {
  it("passes when value >= min", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "numeric_min",
        thresholdValue: { field_path: "total_years_experience", min: 5 },
      }),
    ]);
    expect(r.passed).toBe(true);
  });

  it("fails when value < min", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "numeric_min",
        thresholdValue: { field_path: "total_years_experience", min: 10 },
      }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.failures[0]!.reason).toBe("value_below_min");
    expect(r.failures[0]!.actual).toBe(7);
    expect(r.failures[0]!.threshold).toEqual({ min: 10 });
  });

  it("returns null when the field is not a number", () => {
    const r = evaluateKnockouts({ total_years_experience: "five" }, [
      k({
        type: "numeric_min",
        thresholdValue: { field_path: "total_years_experience", min: 5 },
      }),
    ]);
    expect(r.passed).toBeNull();
    expect(r.failures[0]!.reason).toBe("field_unexpected_type");
  });
});

describe("evaluateKnockouts — numeric_max", () => {
  it("passes when value <= max", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "numeric_max",
        thresholdValue: { field_path: "notice_period_days", max: 60 },
      }),
    ]);
    expect(r.passed).toBe(true);
  });

  it("fails when value > max", () => {
    const r = evaluateKnockouts({ ...baseCv, notice_period_days: 90 }, [
      k({
        type: "numeric_max",
        thresholdValue: { field_path: "notice_period_days", max: 60 },
      }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.failures[0]!.reason).toBe("value_above_max");
  });
});

describe("evaluateKnockouts — enum", () => {
  it("passes on a scalar string in allowed", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "enum",
        thresholdValue: {
          field_path: "personal.location_country",
          allowed: ["IN", "US"],
        },
      }),
    ]);
    expect(r.passed).toBe(true);
  });

  it("passes on an array with non-empty intersection", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "enum",
        thresholdValue: {
          field_path: "skills.technical",
          allowed: ["Kotlin", "Java", "Go"],
        },
      }),
    ]);
    expect(r.passed).toBe(true);
  });

  it("fails on a scalar string not in allowed", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "enum",
        thresholdValue: { field_path: "personal.location_country", allowed: ["US"] },
      }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.failures[0]!.reason).toBe("value_not_in_allowed");
  });

  it("fails on an array with empty intersection", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "enum",
        thresholdValue: { field_path: "skills.technical", allowed: ["Python", "Rust"] },
      }),
    ]);
    expect(r.passed).toBe(false);
  });

  it("returns null when allowed is missing/empty", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "enum",
        thresholdValue: { field_path: "personal.location_country", allowed: [] },
      }),
    ]);
    expect(r.passed).toBeNull();
    expect(r.failures[0]!.reason).toBe("malformed_threshold");
  });
});

describe("evaluateKnockouts — verdict resolution", () => {
  it("returns passed=true when every knockout passes", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        id: "1",
        type: "numeric_min",
        thresholdValue: { field_path: "total_years_experience", min: 5 },
      }),
      k({
        id: "2",
        type: "enum",
        thresholdValue: { field_path: "personal.location_country", allowed: ["IN"] },
      }),
    ]);
    expect(r.passed).toBe(true);
    expect(r.fail_count).toBe(0);
    expect(r.null_count).toBe(0);
  });

  it("returns passed=false when one knockout fails (false beats null)", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        id: "1",
        type: "numeric_min",
        thresholdValue: { field_path: "total_years_experience", min: 10 },
      }),
      k({
        id: "2",
        type: "boolean",
        thresholdValue: { field_path: "skills.never_extracted", required: true },
      }),
    ]);
    expect(r.passed).toBe(false);
    expect(r.fail_count).toBe(1);
    expect(r.null_count).toBe(1);
    expect(r.failures).toHaveLength(2);
  });

  it("returns passed=null when every non-pass is null", () => {
    const r = evaluateKnockouts({ personal: {} }, [
      k({
        id: "1",
        type: "numeric_min",
        thresholdValue: { field_path: "total_years_experience", min: 5 },
      }),
      k({
        id: "2",
        type: "boolean",
        thresholdValue: { field_path: "personal.linkedin_url", required: true },
      }),
    ]);
    expect(r.passed).toBeNull();
    expect(r.fail_count).toBe(0);
    expect(r.null_count).toBe(2);
  });

  it("returns passed=true on an empty knockout list", () => {
    const r = evaluateKnockouts(baseCv, []);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe("evaluateKnockouts — source gating", () => {
  it("returns null for candidate_asserted source (Wave 1 doesn't evaluate it)", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        source: "candidate_asserted",
        type: "boolean",
        thresholdValue: { field_path: "skills.technical", required: true },
      }),
    ]);
    expect(r.passed).toBeNull();
    expect(r.failures[0]!.reason).toBe("source_not_parsed_cv");
  });
});

// ─────────────────────────── PC-7 — screening-answer knockouts ───────────────────────────
//
// candidate_asserted / partner_asserted knockouts read the application's
// screening answers (third argument). Each catalogue field gets pass / fail /
// unknown, plus the notice-period parsed-CV fallback and the pre-PC-7
// compatibility path (no screening view → source_not_parsed_cv).

const noticeKo = (max: number, source = "candidate_asserted") =>
  k({
    id: "22222222-2222-2222-2222-222222222222",
    source,
    type: "numeric_max",
    questionText: "Notice period at most 60 days",
    thresholdValue: {
      field_path: "notice_period_days",
      fallback_field_path: "notice_period_days",
      max,
    },
  });
const ctcKo = (max: number) =>
  k({
    id: "33333333-3333-3333-3333-333333333333",
    source: "candidate_asserted",
    type: "numeric_max",
    thresholdValue: { field_path: "expected_ctc", max },
  });
const locationKo = (allowed: string[]) =>
  k({
    id: "44444444-4444-4444-4444-444444444444",
    source: "candidate_asserted",
    type: "enum",
    thresholdValue: { field_path: "current_location", allowed },
  });

describe("evaluateKnockouts — PC-7 notice_period_days (numeric_max)", () => {
  it("passes when the stated notice is within the max", () => {
    const r = evaluateKnockouts(baseCv, [noticeKo(60)], { notice_period_days: 45 });
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
  it("fails when the stated notice exceeds the max", () => {
    const r = evaluateKnockouts(baseCv, [noticeKo(60)], { notice_period_days: 90 });
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatchObject({
      result: false,
      reason: "value_above_max",
      actual: 90,
      field_path: "notice_period_days",
    });
  });
  it("the stated answer wins over the parsed CV", () => {
    // CV says 30 (would pass); the application answer says 90 (fails).
    const r = evaluateKnockouts(baseCv, [noticeKo(60)], { notice_period_days: 90 });
    expect(r.passed).toBe(false);
  });
  it("falls back to the parsed CV when no answer was given", () => {
    const pass = evaluateKnockouts(baseCv, [noticeKo(60)], {});
    expect(pass.passed).toBe(true);
    const fail = evaluateKnockouts(baseCv, [noticeKo(15)], { notice_period_days: null });
    expect(fail.passed).toBe(false);
    expect(fail.failures[0]!.actual).toBe(30);
  });
  it("is UNKNOWN (null, not a fail) when neither the answer nor the CV has it", () => {
    const cvWithoutNotice = { ...baseCv, notice_period_days: undefined };
    const r = evaluateKnockouts(cvWithoutNotice, [noticeKo(60)], {});
    expect(r.passed).toBeNull();
    expect(r.fail_count).toBe(0);
    expect(r.null_count).toBe(1);
    expect(r.failures[0]).toMatchObject({ result: null, reason: "field_missing" });
  });
  it("partner_asserted reads the same screening view", () => {
    const r = evaluateKnockouts(baseCv, [noticeKo(60, "partner_asserted")], {
      notice_period_days: 120,
    });
    expect(r.passed).toBe(false);
  });
});

describe("evaluateKnockouts — PC-7 expected_ctc (numeric_max)", () => {
  it("passes when the expected CTC is within the max", () => {
    const r = evaluateKnockouts(baseCv, [ctcKo(1_800_000)], { expected_ctc: 1_500_000 });
    expect(r.passed).toBe(true);
  });
  it("passes on the boundary (max is inclusive)", () => {
    const r = evaluateKnockouts(baseCv, [ctcKo(1_800_000)], { expected_ctc: 1_800_000 });
    expect(r.passed).toBe(true);
  });
  it("fails when the expected CTC exceeds the max", () => {
    const r = evaluateKnockouts(baseCv, [ctcKo(1_800_000)], { expected_ctc: 2_400_000 });
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatchObject({ result: false, reason: "value_above_max" });
  });
  it("is UNKNOWN when no expected CTC was given (no CV fallback for pay)", () => {
    const r = evaluateKnockouts(baseCv, [ctcKo(1_800_000)], { expected_ctc: null });
    expect(r.passed).toBeNull();
    expect(r.failures[0]).toMatchObject({ result: null, reason: "field_missing" });
  });
});

describe("evaluateKnockouts — PC-7 current_location (enum)", () => {
  it("passes on an exact allowed value", () => {
    const r = evaluateKnockouts(baseCv, [locationKo(["Pune", "Hyderabad"])], {
      current_location: "Pune",
    });
    expect(r.passed).toBe(true);
  });
  it("passes case-insensitively and on a comma segment", () => {
    const r = evaluateKnockouts(baseCv, [locationKo(["pune"])], {
      current_location: "  PUNE , Maharashtra ",
    });
    expect(r.passed).toBe(true);
  });
  it("fails when the location is not allowed", () => {
    const r = evaluateKnockouts(baseCv, [locationKo(["Pune", "Hyderabad"])], {
      current_location: "Chennai, Tamil Nadu",
    });
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatchObject({ result: false, reason: "value_not_in_allowed" });
  });
  it("is UNKNOWN when no location was given (blank counts as missing)", () => {
    const r = evaluateKnockouts(baseCv, [locationKo(["Pune"])], { current_location: "" });
    expect(r.passed).toBeNull();
    expect(r.failures[0]).toMatchObject({ result: null, reason: "field_missing" });
  });
});

describe("evaluateKnockouts — PC-7 mixed + compatibility", () => {
  it("a fail beats an unknown across parsed-CV and screening knockouts", () => {
    const r = evaluateKnockouts(
      baseCv,
      [
        k({
          type: "numeric_min",
          thresholdValue: { field_path: "total_years_experience", min: 5 },
        }),
        noticeKo(60),
        ctcKo(1_000_000),
        locationKo(["Pune"]),
      ],
      { notice_period_days: 90 },
    );
    expect(r.passed).toBe(false);
    expect(r.fail_count).toBe(1);
    expect(r.null_count).toBe(2);
  });
  it("without a screening view, asserted knockouts keep the pre-PC-7 null/source_not_parsed_cv path", () => {
    const r = evaluateKnockouts(baseCv, [noticeKo(60)]);
    expect(r.passed).toBeNull();
    expect(r.failures[0]!.reason).toBe("source_not_parsed_cv");
  });
  it("parsed_cv enum matching stays exact (case-sensitive) — PC-7 doesn't change it", () => {
    const r = evaluateKnockouts(baseCv, [
      k({
        type: "enum",
        thresholdValue: { field_path: "personal.location_country", allowed: ["in"] },
      }),
    ]);
    expect(r.passed).toBe(false);
  });
});
