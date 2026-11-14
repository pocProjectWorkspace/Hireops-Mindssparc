import { describe, expect, it } from "vitest";
import {
  EMPTY_APPLICABILITY_SUBJECT,
  applicabilityConditionsSchema,
  businessUnitLineage,
  configRecordKey,
  evaluateConditions,
  getStarterPack,
  interviewRoundRecordKey,
  parseInterviewRoundRecordKey,
  parseStoredConditions,
  rankAssignments,
  type ApplicabilitySubject,
  type AssignmentCandidate,
} from "../src";

const u = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

// BU tree: 1 Finance ─┬─ 2 AP ── 3 AP India
//                     └─ 4 R2R
//          5 HR (separate root)
const UNITS = [
  { id: u(1), parentId: null },
  { id: u(2), parentId: u(1) },
  { id: u(3), parentId: u(2) },
  { id: u(4), parentId: u(1) },
  { id: u(5), parentId: null },
];
const ENTITY_IN = u(100);
const FN_R2R = u(200);
const LOOP_DEFAULT = u(300);
const LOOP_SENIOR = u(301);
const LOOP_AP = u(302);

function subject(over: Partial<ApplicabilitySubject> = {}): ApplicabilitySubject {
  const bu = over.business_unit_id ?? u(3);
  return {
    ...EMPTY_APPLICABILITY_SUBJECT,
    legal_entity_id: ENTITY_IN,
    country_code: "IN",
    business_unit_id: bu,
    business_unit_lineage: businessUnitLineage(UNITS, bu),
    job_function_id: FN_R2R,
    job_level_rank: 14,
    employment_type_key: "permanent",
    ...over,
  };
}

function a(
  id: number,
  templateId: string,
  conditions: unknown,
  extra: Partial<AssignmentCandidate> = {},
): AssignmentCandidate {
  return {
    id: u(id),
    name: `a${id}`,
    templateKind: "interview_loop",
    templateId,
    priority: 0,
    isActive: true,
    conditions,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    ...extra,
  };
}

describe("businessUnitLineage", () => {
  it("walks to the root, is cycle-safe and handles unknown / null ids", () => {
    expect(businessUnitLineage(UNITS, u(3))).toEqual([u(3), u(2), u(1)]);
    expect(businessUnitLineage(UNITS, u(5))).toEqual([u(5)]);
    expect(businessUnitLineage(UNITS, u(99))).toEqual([u(99)]);
    expect(businessUnitLineage(UNITS, null)).toEqual([]);
    const cyclic = [
      { id: u(1), parentId: u(2) },
      { id: u(2), parentId: u(1) },
    ];
    expect(businessUnitLineage(cyclic, u(1))).toEqual([u(1), u(2)]);
  });
});

describe("conditions schema", () => {
  it("accepts the typed predicates, upper-cases countries, rejects unknown keys and bad ranges", () => {
    const ok = applicabilityConditionsSchema.parse({
      country_code: { in: ["in"] },
      job_level_rank: { min: 12 },
    });
    expect(ok.country_code?.in).toEqual(["IN"]);
    expect(applicabilityConditionsSchema.safeParse({ band: { in: ["x"] } }).success).toBe(false);
    expect(applicabilityConditionsSchema.safeParse({ job_level_rank: {} }).success).toBe(false);
    expect(
      applicabilityConditionsSchema.safeParse({ job_level_rank: { min: 15, max: 12 } }).success,
    ).toBe(false);
    expect(applicabilityConditionsSchema.safeParse({ location_id: { in: [] } }).success).toBe(
      false,
    );
    expect(applicabilityConditionsSchema.safeParse({ location_id: { in: ["nope"] } }).success).toBe(
      false,
    );
  });
  it("a malformed stored blob parses to null (matches nothing)", () => {
    expect(parseStoredConditions({ nope: 1 })).toBeNull();
    expect(parseStoredConditions(null)).toEqual({});
  });
});

describe("evaluateConditions", () => {
  it("empty conditions match everything with zero specificity", () => {
    const ev = evaluateConditions({}, subject());
    expect(ev).toEqual({ matches: true, matched: [], failed: [] });
  });

  it("business unit matches the unit and every descendant, not siblings or ancestors", () => {
    const onFinance = { business_unit_id: { in: [u(1)] } };
    expect(evaluateConditions(onFinance, subject({ business_unit_id: u(3) })).matches).toBe(true);
    expect(evaluateConditions(onFinance, subject({ business_unit_id: u(4) })).matches).toBe(true);
    expect(evaluateConditions(onFinance, subject({ business_unit_id: u(5) })).matches).toBe(false);
    const onAp = { business_unit_id: { in: [u(2)] } };
    expect(evaluateConditions(onAp, subject({ business_unit_id: u(1) })).matches).toBe(false);
    expect(evaluateConditions(onAp, subject({ business_unit_id: u(4) })).matches).toBe(false);
    // Lineage missing → the unit itself still matches.
    expect(
      evaluateConditions(onAp, subject({ business_unit_id: u(2), business_unit_lineage: [] }))
        .matches,
    ).toBe(true);
  });

  it("rank ranges are inclusive; open bounds work; unknown rank never matches", () => {
    const r = (min?: number, max?: number) => ({ job_level_rank: { min, max } });
    expect(evaluateConditions(r(14, 14), subject()).matches).toBe(true);
    expect(evaluateConditions(r(12, 13), subject()).matches).toBe(false);
    expect(evaluateConditions(r(15), subject()).matches).toBe(false);
    expect(evaluateConditions(r(undefined, 14), subject()).matches).toBe(true);
    expect(evaluateConditions(r(1), subject({ job_level_rank: null })).matches).toBe(false);
  });

  it("is an AND: reports matched and failed predicates; null attributes fail", () => {
    const ev = evaluateConditions(
      {
        legal_entity_id: { in: [ENTITY_IN] },
        country_code: { in: ["IN"] },
        job_function_id: { in: [u(201)] },
        location_id: { in: [u(400)] },
      },
      subject(),
    );
    expect(ev.matches).toBe(false);
    expect(ev.matched).toEqual(["legal_entity_id", "country_code"]);
    expect(ev.failed).toEqual(["location_id", "job_function_id"]);
    expect(
      evaluateConditions({ employment_type_key: { in: ["permanent", "contract"] } }, subject())
        .matches,
    ).toBe(true);
  });
});

describe("rankAssignments", () => {
  const assignments = [
    a(1, LOOP_DEFAULT, {}),
    a(2, LOOP_SENIOR, { job_level_rank: { min: 13 } }),
    a(3, LOOP_AP, { business_unit_id: { in: [u(2)] }, job_level_rank: { min: 10 } }),
  ];

  it("most specific match wins", () => {
    const r = rankAssignments("interview_loop", assignments, subject());
    expect(r.winner?.templateId).toBe(LOOP_AP);
    expect(r.winner?.matchedPredicates).toEqual(["business_unit_id", "job_level_rank"]);
    expect(r.winner?.isDefault).toBe(false);
    expect(r.winner?.ties).toEqual([]);
  });

  it("falls through to less specific, then the empty-condition default", () => {
    const hr = subject({ business_unit_id: u(5) });
    expect(rankAssignments("interview_loop", assignments, hr).winner?.templateId).toBe(LOOP_SENIOR);
    const junior = subject({ business_unit_id: u(5), job_level_rank: 9 });
    const w = rankAssignments("interview_loop", assignments, junior).winner;
    expect(w?.templateId).toBe(LOOP_DEFAULT);
    expect(w?.isDefault).toBe(true);
  });

  it("no assignments / no match → null (the caller's fallback)", () => {
    expect(rankAssignments("interview_loop", [], subject()).winner).toBeNull();
    const only = [a(2, LOOP_SENIOR, { job_level_rank: { min: 20 } })];
    expect(rankAssignments("interview_loop", only, subject()).winner).toBeNull();
  });

  it("equal specificity: priority wins, then newest, and ties are reported", () => {
    const same = { country_code: { in: ["IN"] } };
    const older = a(10, LOOP_SENIOR, same, { createdAt: "2026-01-01T00:00:00Z" });
    const newer = a(11, LOOP_AP, same, { createdAt: "2026-02-01T00:00:00Z" });
    const r1 = rankAssignments("interview_loop", [older, newer], subject());
    expect(r1.winner?.templateId).toBe(LOOP_AP);
    expect(r1.winner?.ties.map((t) => t.assignmentId)).toEqual([u(10)]);
    const pri = a(10, LOOP_SENIOR, same, { createdAt: "2026-01-01T00:00:00Z", priority: 5 });
    const r2 = rankAssignments("interview_loop", [pri, newer], subject());
    expect(r2.winner?.templateId).toBe(LOOP_SENIOR);
    expect(r2.winner?.ties).toEqual([]);
    // Specificity beats priority.
    const loud = a(12, LOOP_DEFAULT, {}, { priority: 1000 });
    expect(rankAssignments("interview_loop", [loud, newer], subject()).winner?.templateId).toBe(
      LOOP_AP,
    );
  });

  it("skips inactive, malformed, other-kind and unusable-target assignments", () => {
    const list = [
      a(20, LOOP_AP, { country_code: { in: ["IN"] } }, { isActive: false }),
      a(21, LOOP_SENIOR, { bogus: true }),
      a(22, LOOP_SENIOR, {}, { templateKind: "scorecard" }),
      a(23, LOOP_DEFAULT, {}),
      a(24, LOOP_SENIOR, { job_function_id: { in: [FN_R2R] } }),
    ];
    const r = rankAssignments("interview_loop", list, subject(), (id) =>
      id === LOOP_SENIOR ? "the loop has no rounds" : null,
    );
    expect(r.winner?.assignmentId).toBe(u(23));
    const why = Object.fromEntries(r.evaluated.map((e) => [e.name, e.skippedReason]));
    expect(why).toEqual({
      a20: "inactive",
      a21: "conditions are malformed",
      a23: null,
      a24: "the loop has no rounds",
    });
  });
});

describe("config natural keys for loops + assignments", () => {
  it("round keys stay bare for the default loop", () => {
    expect(interviewRoundRecordKey(undefined, 2)).toBe("2");
    expect(interviewRoundRecordKey("default", 2)).toBe("2");
    expect(interviewRoundRecordKey("senior", 2)).toBe("senior:2");
    expect(parseInterviewRoundRecordKey("2")).toEqual({ loopKey: "default", roundNumber: 2 });
    expect(parseInterviewRoundRecordKey("senior:3")).toEqual({ loopKey: "senior", roundNumber: 3 });
    expect(configRecordKey("interviewRounds", { loopKey: "senior", roundNumber: 1 })).toBe(
      "senior:1",
    );
    expect(
      configRecordKey("templateAssignments", { templateKind: "scorecard", name: "Default" }),
    ).toBe("scorecard:Default");
  });

  it("india pack: default loop + default loop/scorecard assignments with no conditions", () => {
    const p = getStarterPack("india-gcc-finance-gbs");
    expect(p?.version).toBe(2);
    expect(p?.config.interviewLoops?.map((l) => l.loopKey)).toEqual(["default"]);
    expect(
      p?.config.templateAssignments?.map((t) => [t.templateKind, t.template, t.conditions]),
    ).toEqual([
      ["interview_loop", "default", {}],
      ["scorecard", "gcc_competencies", {}],
    ]);
  });
});
