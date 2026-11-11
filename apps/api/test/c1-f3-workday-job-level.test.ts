/**
 * C1-F3 — Workday import: Compensation Grade → tenant job level, by KEY.
 * PURE unit suite (no DB, no AI): pins matchJobLevel + the mapWorkdayRow
 * level row / resolved.jobLevelId, and that tenants with no levels see the
 * pre-0133 mapping unchanged.
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { WORKDAY_SAMPLE_REQUISITIONS, type WorkdayRequisitionRow } from "@hireops/api-types";
import {
  mapWorkdayRow,
  matchJobLevel,
  workdaySampleRows,
  type WorkdayTenantLookups,
} from "../src/lib/workday-import";

const TODAY = new Date("2026-10-08T00:00:00Z");
const SAMPLE = workdaySampleRows(WORKDAY_SAMPLE_REQUISITIONS, TODAY);
function rowWithGrade(grade: string): WorkdayRequisitionRow {
  const r = SAMPLE[0];
  if (!r) throw new Error("missing sample row");
  return { ...r, compensationGrade: grade };
}

const LEVELS = [
  { id: "lv9", key: "IN09", label: "Band 9" },
  { id: "lv12", key: "IN12", label: "Band 12" },
];
const BANDS = [
  { id: "b-name", name: "Acme IN12 — Specialist", level: null, jobLevelId: null },
  { id: "b-pinned", name: "Band 12 Hyderabad", level: null, jobLevelId: "lv12" },
];
const BASE: WorkdayTenantLookups = {
  businessUnits: [{ id: "u1", name: "GBS India — Hyderabad" }],
  members: [],
  compBands: BANDS,
  jobLevels: LEVELS,
};

describe("C1-F3 workday grade → job level", () => {
  it("matches by key only, case / punctuation-insensitive", () => {
    assert.equal(matchJobLevel("IN12", LEVELS)?.id, "lv12");
    assert.equal(matchJobLevel("in-12", LEVELS)?.id, "lv12");
    assert.equal(matchJobLevel(" in 09 ", LEVELS)?.id, "lv9");
    // label is NOT a key; no partial / fuzzy match
    assert.equal(matchJobLevel("Band 12", LEVELS), null);
    assert.equal(matchJobLevel("IN1", LEVELS), null);
    assert.equal(matchJobLevel("", LEVELS), null);
  });

  it("a mapped grade sets resolved.jobLevelId and prefers the band pinned to that level", () => {
    const { mapping, resolved } = mapWorkdayRow(rowWithGrade("IN12"), BASE, "Caller");
    assert.equal(resolved.jobLevelId, "lv12");
    assert.equal(resolved.compBandId, "b-pinned");
    const levelRow = mapping.find((m) => m.hireopsField === "Job level");
    assert.ok(levelRow);
    assert.equal(levelRow.status, "mapped");
    assert.equal(levelRow.hireopsValue, "Band 12 (IN12)");
  });

  it("an unknown grade is flagged for review, level left null; band falls back to the name match", () => {
    const { mapping, resolved } = mapWorkdayRow(rowWithGrade("IN14"), BASE, "Caller");
    assert.equal(resolved.jobLevelId, null);
    const levelRow = mapping.find((m) => m.hireopsField === "Job level");
    assert.equal(levelRow?.status, "needs_review");
    assert.match(levelRow?.note ?? "", /No job level with key IN14/);
    // Grade IN12 band-name fallback still works when no level matched:
    const named = mapWorkdayRow(rowWithGrade("IN12"), { ...BASE, jobLevels: [] }, "Caller");
    assert.equal(named.resolved.compBandId, "b-name");
  });

  it("tenants without job levels get no level row (pre-0133 mapping unchanged)", () => {
    const noLevels: WorkdayTenantLookups = { ...BASE, jobLevels: undefined };
    const { mapping, resolved } = mapWorkdayRow(rowWithGrade("IN12"), noLevels, "Caller");
    assert.equal(resolved.jobLevelId, null);
    assert.equal(
      mapping.some((m) => m.hireopsField === "Job level"),
      false,
    );
    assert.equal(resolved.compBandId, "b-name");
  });
});
