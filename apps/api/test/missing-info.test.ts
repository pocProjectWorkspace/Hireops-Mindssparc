/**
 * RECR-03 — Missing Info deterministic rule engine (PURE unit suite, no DB, no
 * AI). Pins apps/api/src/lib/missing-info.ts:
 *
 *   - the field registry's requiredness (required vs optional) per field,
 *   - the deterministic "Blocks Advance to <stage>" label per field (and that
 *     an optional field blocks nothing),
 *   - computeMissingInfo emits ONLY absent fields, in registry order,
 *   - the REFUSAL guarantee: the verdict shape carries NO score/cap field.
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import {
  MISSING_INFO_FIELDS,
  MISSING_INFO_FIELD_KEYS,
  computeMissingInfo,
  blocksAdvanceLabelFor,
  fieldDef,
  isMissingInfoFieldKey,
  type FieldPresence,
} from "../src/lib/missing-info";

describe("RECR-03 missing-info rule engine (pure)", () => {
  it("registry covers exactly the seven canonical field keys, in order", () => {
    assert.deepEqual(
      MISSING_INFO_FIELDS.map((f) => f.key),
      [...MISSING_INFO_FIELD_KEYS],
    );
    assert.deepEqual(
      [...MISSING_INFO_FIELD_KEYS],
      [
        "expected_salary",
        "notice_period",
        "availability_date",
        "work_authorization",
        "current_location",
        "skills_confirmation",
        "education_year",
      ],
    );
  });

  it("requiredness: the six operational fields are required; education year is optional", () => {
    for (const key of [
      "expected_salary",
      "notice_period",
      "availability_date",
      "work_authorization",
      "current_location",
      "skills_confirmation",
    ] as const) {
      assert.equal(fieldDef(key)?.requiredness, "required", `${key} should be required`);
    }
    assert.equal(fieldDef("education_year")?.requiredness, "optional");
  });

  it("blocks-advance: offer-desk fields gate the Offer stage", () => {
    for (const key of ["expected_salary", "notice_period", "availability_date"] as const) {
      assert.equal(fieldDef(key)?.blocksAdvanceStage, "offer_drafted");
      assert.equal(blocksAdvanceLabelFor(key), "Blocks advance to Offer");
    }
  });

  it("blocks-advance: eligibility fields gate the Technical interview stage", () => {
    for (const key of ["work_authorization", "current_location", "skills_confirmation"] as const) {
      assert.equal(fieldDef(key)?.blocksAdvanceStage, "tech_interview");
      assert.equal(blocksAdvanceLabelFor(key), "Blocks advance to Technical interview");
    }
  });

  it("blocks-advance: an OPTIONAL field blocks nothing (null label — never a cap)", () => {
    assert.equal(fieldDef("education_year")?.blocksAdvanceStage, null);
    assert.equal(blocksAdvanceLabelFor("education_year"), null);
  });

  it("computeMissingInfo emits ONLY fields explicitly marked absent, in registry order", () => {
    const presence: FieldPresence = {
      expected_salary: false, // missing
      notice_period: true, // present
      availability_date: false, // missing
      work_authorization: true, // present
      current_location: true, // present
      skills_confirmation: true, // present
      education_year: false, // missing (optional)
    };
    const out = computeMissingInfo(presence);
    assert.deepEqual(
      out.map((v) => v.fieldKey),
      ["expected_salary", "availability_date", "education_year"],
    );
  });

  it("computeMissingInfo treats an UNKNOWN (absent-from-map) field as not-missing", () => {
    // Only expected_salary is stated missing; everything else is unknown and
    // must NOT be emitted (the engine classifies, it does not assume).
    const out = computeMissingInfo({ expected_salary: false });
    assert.deepEqual(
      out.map((v) => v.fieldKey),
      ["expected_salary"],
    );
  });

  it("empty presence map yields no rows", () => {
    assert.deepEqual(computeMissingInfo({}), []);
  });

  it("REFUSAL: a verdict has no score / cap / penalty field — honesty guarantee", () => {
    const [v] = computeMissingInfo({ expected_salary: false });
    assert.ok(v, "expected one verdict");
    const keys = Object.keys(v);
    assert.deepEqual(
      keys.sort(),
      ["blocksAdvanceLabel", "blocksAdvanceStage", "fieldKey", "fieldLabel", "requiredness"].sort(),
    );
    for (const forbidden of ["score", "scoreImpact", "cap", "cappedAt", "penalty"]) {
      assert.ok(!(forbidden in v), `verdict must not carry a '${forbidden}' field`);
    }
  });

  it("isMissingInfoFieldKey guards the registry keys", () => {
    assert.equal(isMissingInfoFieldKey("expected_salary"), true);
    assert.equal(isMissingInfoFieldKey("nope"), false);
  });
});
