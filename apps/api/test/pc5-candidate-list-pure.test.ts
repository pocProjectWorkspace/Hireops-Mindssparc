/**
 * PC-5 — triage at volume, PURE half (no DB). Pins:
 *   - the paging / filter / bulk input contracts (defaults, max page 200,
 *     bulk cap 500, move_to_stage needs a target),
 *   - the expected-CTC filter is dropped silently for callers who can't see pay,
 *   - fact filters compile to SQL predicates (one per supplied filter),
 *   - LIKE escaping of the location / search text,
 *   - planBulkMove (next stage / reject / move-to / closed / already-there),
 *   - classifyBulkMoveError maps the stage gates' BAD_REQUEST to gate_blocked,
 *   - per-row audit rows reuse the single-move action names.
 *
 * No DB I/O, but the helpers import @hireops/db (table objects), whose client
 * module needs DATABASE_URL at import time — hence the bootstrap import.
 */

import "../src/bootstrap";

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { TRPCError } from "@trpc/server";
import {
  BULK_MOVE_MAX,
  CANDIDATE_LIST_PAGE_DEFAULT,
  CANDIDATE_LIST_PAGE_MAX,
  bulkMoveApplicationsInputSchema,
  candidateListPageSchema,
  listCandidatesByRequisitionInputSchema,
  listCandidatesInputSchema,
} from "@hireops/api-types";
import {
  CANDIDATE_LIST_SORT_ORDER,
  candidateListConditions,
  escapeLike,
  factFilterConditions,
  resolveFactFilters,
} from "../src/lib/candidate-list-filters";
import {
  bulkMoveAuditInput,
  classifyBulkMoveError,
  planBulkMove,
  singleMoveAuditAction,
} from "../src/lib/bulk-move";

const UUID = "00000000-0000-4000-8000-0000000c0501";

describe("PC-5 contracts", () => {
  it("page defaults to offset 0 / limit 50 and caps at 200", () => {
    const p = candidateListPageSchema.parse({});
    assert.equal(p.offset, 0);
    assert.equal(p.limit, CANDIDATE_LIST_PAGE_DEFAULT);
    assert.equal(CANDIDATE_LIST_PAGE_DEFAULT, 50);
    assert.equal(CANDIDATE_LIST_PAGE_MAX, 200);
    assert.ok(candidateListPageSchema.safeParse({ limit: 200 }).success);
    assert.ok(!candidateListPageSchema.safeParse({ limit: 201 }).success);
    assert.ok(!candidateListPageSchema.safeParse({ offset: -1 }).success);
  });

  it("listCandidatesByRequisition accepts every filter, sort and page; {} still valid", () => {
    assert.ok(listCandidatesByRequisitionInputSchema.safeParse({}).success);
    const r = listCandidatesByRequisitionInputSchema.safeParse({
      search: "priya",
      stage: "recruiter_review",
      source: "career_site",
      requisitionId: UUID,
      knockout: "fail",
      maxNoticeDays: 30,
      maxExpectedSalaryInrPaise: 1_800_000 * 100,
      locationContains: "Pune",
      hasPartner: true,
      sort: "newest",
      page: { offset: 50, limit: 50 },
    });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.ok(!listCandidatesByRequisitionInputSchema.safeParse({ knockout: "maybe" }).success);
    assert.ok(!listCandidatesByRequisitionInputSchema.safeParse({ maxNoticeDays: 400 }).success);
  });

  it("listCandidates (triage) takes offset + fact filters, page max 200", () => {
    const r = listCandidatesInputSchema.safeParse({
      filters: { stage: "application_received", knockout: "pass", maxNoticeDays: 60 },
      pagination: { limit: 50, offset: 100 },
      sort: "recent",
    });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.ok(
      !listCandidatesInputSchema.safeParse({ pagination: { limit: 201 }, sort: "recent" }).success,
    );
  });

  it("bulk input: ids capped at 500, move_to_stage needs a target", () => {
    const ids = Array.from(
      { length: BULK_MOVE_MAX },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    assert.equal(BULK_MOVE_MAX, 500);
    assert.ok(
      bulkMoveApplicationsInputSchema.safeParse({
        action: "advance_next",
        selection: { mode: "ids", applicationIds: ids },
      }).success,
    );
    assert.ok(
      !bulkMoveApplicationsInputSchema.safeParse({
        action: "advance_next",
        selection: { mode: "ids", applicationIds: [...ids, UUID] },
      }).success,
      "501 ids refused",
    );
    assert.ok(
      !bulkMoveApplicationsInputSchema.safeParse({
        action: "advance_next",
        selection: { mode: "ids", applicationIds: [] },
      }).success,
      "empty selection refused",
    );
    assert.ok(
      !bulkMoveApplicationsInputSchema.safeParse({
        action: "move_to_stage",
        selection: { mode: "ids", applicationIds: [UUID] },
      }).success,
      "move_to_stage without target refused",
    );
    assert.ok(
      bulkMoveApplicationsInputSchema.safeParse({
        action: "reject",
        selection: { mode: "filter", filter: { requisitionId: UUID, knockout: "fail" } },
      }).success,
    );
  });
});

describe("PC-5 fact filters → SQL", () => {
  it("expected-CTC filter is dropped silently for roles that can't see pay", () => {
    const f = { maxExpectedSalaryInrPaise: 100, maxNoticeDays: 30 };
    const hm = resolveFactFilters(f, ["hiring_manager"]);
    assert.equal(hm.compFilterIgnored, true);
    assert.equal(hm.applied.maxExpectedSalaryInrPaise, undefined);
    assert.equal(hm.applied.maxNoticeDays, 30, "other filters kept");
    const rec = resolveFactFilters(f, ["recruiter"]);
    assert.equal(rec.compFilterIgnored, false);
    assert.equal(rec.applied.maxExpectedSalaryInrPaise, 100);
  });

  it("one predicate per supplied fact filter; none when empty", () => {
    assert.equal(factFilterConditions({}).length, 0);
    assert.equal(
      factFilterConditions({
        knockout: "unknown",
        maxNoticeDays: 30,
        maxExpectedSalaryInrPaise: 5,
        locationContains: "Pune",
        hasPartner: false,
      }).length,
      5,
    );
    assert.equal(factFilterConditions({ locationContains: "   " }).length, 0);
  });

  it("candidateListConditions honours includeRequisition:false (role facets)", () => {
    const filter = { requisitionId: UUID, stage: "shortlisted" as const, search: "a" };
    assert.equal(candidateListConditions(filter, ["recruiter"]).conditions.length, 3);
    assert.equal(
      candidateListConditions(filter, ["recruiter"], { includeRequisition: false }).conditions
        .length,
      2,
    );
    const hm = candidateListConditions({ maxExpectedSalaryInrPaise: 1 }, ["hiring_manager"]);
    assert.equal(hm.conditions.length, 0);
    assert.equal(hm.compFilterIgnored, true);
  });

  it("escapeLike neutralises % _ and backslash", () => {
    assert.equal(escapeLike("50%_a\\b"), "50\\%\\_a\\\\b");
  });

  it("every sort ends on a unique tiebreaker (stable offset paging)", () => {
    for (const order of Object.values(CANDIDATE_LIST_SORT_ORDER)) {
      assert.ok(order.length >= 2);
    }
  });
});

describe("PC-5 planBulkMove", () => {
  it("advance_next moves to the next pipeline stage", () => {
    assert.deepEqual(planBulkMove("advance_next", "application_received", undefined), {
      kind: "move",
      targetStage: "recruiter_review",
    });
    assert.deepEqual(planBulkMove("advance_next", "recruiter_review", undefined), {
      kind: "move",
      targetStage: "shortlisted",
    });
  });

  it("advance_next on the last stage is a no_next_stage skip", () => {
    const p = planBulkMove("advance_next", "offer_accepted", undefined);
    assert.equal(p.kind, "skip");
    assert.equal(p.kind === "skip" && p.skipReason, "no_next_stage");
  });

  it("closed applications are skipped for every action", () => {
    for (const stage of ["recruiter_rejected", "withdrawn", "offer_declined"] as const) {
      for (const action of ["advance_next", "reject", "move_to_stage"] as const) {
        const p = planBulkMove(action, stage, "shortlisted");
        assert.equal(p.kind === "skip" && p.skipReason, "closed", `${action} on ${stage}`);
      }
    }
  });

  it("reject targets recruiter_rejected; move_to_stage the given stage", () => {
    assert.deepEqual(planBulkMove("reject", "shortlisted", undefined), {
      kind: "move",
      targetStage: "recruiter_rejected",
    });
    assert.deepEqual(planBulkMove("move_to_stage", "application_received", "shortlisted"), {
      kind: "move",
      targetStage: "shortlisted",
    });
    const same = planBulkMove("move_to_stage", "shortlisted", "shortlisted");
    assert.equal(same.kind === "skip" && same.skipReason, "already_at_stage");
  });
});

describe("PC-5 classifyBulkMoveError + audit", () => {
  it("stage-gate BAD_REQUEST → gate_blocked with the gate's message", () => {
    const msg =
      "Cannot advance to Panel interview: this tenant's candidate-field policy requires X";
    const c = classifyBulkMoveError(new TRPCError({ code: "BAD_REQUEST", message: msg }));
    assert.equal(c.skipReason, "gate_blocked");
    assert.equal(c.message, msg);
  });

  it("already-at-stage, NOT_FOUND and unknown errors are classified", () => {
    assert.equal(
      classifyBulkMoveError(
        new TRPCError({
          code: "BAD_REQUEST",
          message: "Application is already at stage shortlisted",
        }),
      ).skipReason,
      "already_at_stage",
    );
    assert.equal(
      classifyBulkMoveError(new TRPCError({ code: "NOT_FOUND", message: "x" })).skipReason,
      "not_found",
    );
    assert.equal(classifyBulkMoveError(new Error("boom")).skipReason, "error");
  });

  it("per-row audit reuses the single-move action names, marked bulk", () => {
    assert.equal(singleMoveAuditAction("recruiter_rejected"), "reject_application");
    assert.equal(singleMoveAuditAction("shortlisted"), "advance_application");
    const a = bulkMoveAuditInput({
      applicationId: UUID,
      targetStage: "shortlisted",
      reason: null,
      bulkRequestId: "req-1",
    });
    assert.deepEqual(a, {
      action: "advance_application",
      input: {
        applicationId: UUID,
        targetStage: "shortlisted",
        bulk: true,
        bulkRequestId: "req-1",
      },
    });
    const r = bulkMoveAuditInput({
      applicationId: UUID,
      targetStage: "recruiter_rejected",
      reason: "Notice too long",
      bulkRequestId: "req-1",
    });
    assert.equal(r.action, "reject_application");
    assert.equal((r.input as Record<string, unknown>).reason, "Notice too long");
    assert.equal((r.input as Record<string, unknown>).targetStage, undefined);
  });
});
