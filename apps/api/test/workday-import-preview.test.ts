/**
 * Workday import PoC preview — PURE unit suite (no DB, no AI).
 *
 * Pins the mapping/validation helpers in apps/api/src/lib/workday-import.ts
 * with the tenant lookups injected: grade → comp band, hiring-manager name
 * matching, supervisory org → business unit (exact vs flagged fallback), and
 * the per-row mapped / needs_review status.
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { WORKDAY_SAMPLE_REQUISITIONS } from "@hireops/api-types";
import {
  buildWorkdayPreviewRow,
  locationToPrimaryLocation,
  mapWorkdayRow,
  matchBusinessUnit,
  matchCompBand,
  matchMemberByName,
  normaliseName,
  targetHireDateIso,
  workdayJdSections,
  type WorkdayTenantLookups,
} from "../src/lib/workday-import";

const BANDS = [
  { id: "b1", name: "Solenis IN09 — Assistant / Analyst", level: "IN09" },
  { id: "b2", name: "Solenis IN12 — Specialist / Senior Analyst", level: null },
  { id: "b3", name: "Leadership", level: "Leadership" },
];
const MEMBERS = [
  { membershipId: "m1", displayName: "Suresh Venkataraman" },
  { membershipId: "m2", displayName: "Nisha Balakrishnan" },
  { membershipId: "m3", displayName: null },
];
const UNITS = [
  { id: "u1", name: "GBS India — Hyderabad" },
  { id: "u2", name: "GBS India — Order to Cash" },
];

function sampleRow(i: number) {
  const r = WORKDAY_SAMPLE_REQUISITIONS[i];
  if (!r) throw new Error(`missing sample row ${i}`);
  return r;
}
const row0 = sampleRow(0);
const row2 = sampleRow(2);

describe("workday import — sample data", () => {
  it("ships exactly the three sample requisitions", () => {
    assert.deepEqual(
      WORKDAY_SAMPLE_REQUISITIONS.map((r) => r["Job Requisition ID"]),
      ["JR-24117", "JR-24121", "JR-24130"],
    );
    for (const r of WORKDAY_SAMPLE_REQUISITIONS) {
      assert.ok(r.jobDescription.length >= 3 && r.jobDescription.length <= 5);
      assert.ok(r.skills.length >= 4 && r.skills.length <= 5);
    }
  });
});

describe("workday import — matchers", () => {
  it("normalises names (case, dashes, whitespace)", () => {
    assert.equal(normaliseName("  GBS India — Order  to Cash "), "gbs india order to cash");
  });

  it("matches grade to band by level first, then by whole token in name", () => {
    assert.equal(matchCompBand("IN09", BANDS)?.id, "b1");
    assert.equal(matchCompBand("in12", BANDS)?.id, "b2");
    assert.equal(matchCompBand("IN14", BANDS), null);
    // No partial-token match: "IN1" must not hit "IN12".
    assert.equal(matchCompBand("IN1", BANDS), null);
    assert.equal(matchCompBand("", BANDS), null);
  });

  it("matches hiring manager by exact normalised display name only", () => {
    assert.equal(matchMemberByName("suresh  venkataraman", MEMBERS)?.membershipId, "m1");
    assert.equal(matchMemberByName("Suresh", MEMBERS), null);
    assert.equal(matchMemberByName("Suman Reddy", MEMBERS), null);
  });

  it("maps supervisory org to an exact unit, else a flagged fallback", () => {
    const exact = matchBusinessUnit("GBS India — Order to Cash", UNITS);
    assert.equal(exact.unit?.id, "u2");
    assert.equal(exact.exact, true);
    const fallback = matchBusinessUnit("GBS India — Procure to Pay", UNITS);
    assert.equal(fallback.unit?.id, "u1");
    assert.equal(fallback.exact, false);
    const firstUnit = matchBusinessUnit("Corporate Finance", UNITS);
    assert.equal(firstUnit.unit?.id, "u1");
    assert.equal(firstUnit.exact, false);
    assert.equal(matchBusinessUnit("Anything", []).unit, null);
  });

  it("derives location and target date", () => {
    assert.equal(locationToPrimaryLocation("Hyderabad, India"), "Hyderabad");
    assert.equal(targetHireDateIso(42, new Date("2026-10-08T10:00:00Z")), "2026-11-19");
  });
});

describe("workday import — row mapping", () => {
  const today = new Date("2026-10-08T00:00:00Z");
  const lookups: WorkdayTenantLookups = {
    businessUnits: UNITS,
    members: MEMBERS,
    compBands: BANDS,
  };

  it("marks a fully-resolvable row as mapped with resolved ids", () => {
    const { mapping, resolved } = mapWorkdayRow(row0, lookups, "Ravi", today);
    const byField = new Map(mapping.map((m) => [m.workdayField, m]));
    assert.equal(byField.get("Supervisory Organization")?.status, "mapped");
    assert.equal(byField.get("Hiring Manager")?.status, "mapped");
    assert.equal(byField.get("Compensation Grade")?.status, "mapped");
    assert.equal(
      byField.get("Compensation Grade")?.hireopsValue,
      "Solenis IN09 — Assistant / Analyst",
    );
    assert.equal(byField.get("Worker Type")?.status, "not_imported");
    assert.deepEqual(resolved, {
      businessUnitId: "u2",
      hiringManagerMembershipId: "m1",
      compBandId: "b1",
      primaryLocation: "Hyderabad",
      targetStartDate: "2026-11-19",
    });
  });

  it("flags unknown manager, unmatched grade and fallback BU as needs_review", () => {
    const { mapping, resolved } = mapWorkdayRow(row2, lookups, "Ravi", today);
    const byField = new Map(mapping.map((m) => [m.workdayField, m]));
    assert.equal(byField.get("Hiring Manager")?.status, "needs_review");
    assert.equal(byField.get("Hiring Manager")?.hireopsValue, "Ravi");
    assert.equal(byField.get("Compensation Grade")?.status, "needs_review");
    assert.equal(byField.get("Supervisory Organization")?.status, "needs_review");
    assert.equal(resolved.hiringManagerMembershipId, null);
    assert.equal(resolved.compBandId, null);
    assert.equal(resolved.businessUnitId, "u1");
  });

  it("builds a preview row with review count and already-imported flag", () => {
    const fresh = buildWorkdayPreviewRow(row2, lookups, null, null, today);
    assert.equal(fresh.needsReviewCount, 3);
    assert.equal(fresh.alreadyImported, null);
    assert.equal(fresh.fields["Target Hire Date"], "2026-12-03");
    const done = buildWorkdayPreviewRow(
      row0,
      lookups,
      null,
      "00000000-0000-4000-8000-000000000001",
      today,
    );
    assert.equal(done.needsReviewCount, 0);
    assert.equal(done.alreadyImported?.requisitionId, "00000000-0000-4000-8000-000000000001");
  });

  it("seeds JD sections from the sample description + skills", () => {
    const s = workdayJdSections(row0);
    assert.deepEqual(s.responsibilities, row0.jobDescription);
    assert.equal(s.requirements.length, row0.skills.length);
    assert.ok(s.summary.includes("JR-24117"));
  });
});
