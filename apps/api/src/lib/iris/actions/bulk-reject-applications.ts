/**
 * Iris action: bulk_reject_applications (IRIS-B2) — FILTER-based bulk reject.
 * DESTRUCTIVE. The user names a requisition + the CURRENT stage; Iris resolves
 * that filter to the concrete set of matching applications, PREVIEWS the exact
 * count + list with explicit destructive framing, and only after Confirm LOOPS
 * the real per-entity gated `rejectApplication` procedure over each one.
 *
 * HONESTY. Bulk is a LOOP of the real gated procedure a recruiter uses, not a
 * special bulk write. Every iteration runs rejectApplication through the
 * in-process caller — its own RLS + `withAudit("reject_application", …)` fire per
 * row, and irisExecute records one assistant_actions provenance row per rejected
 * application (a pill per candidate). Partial failure is TOLERATED: one bad row
 * is counted in `failed` and the batch continues.
 */

import {
  bulkRejectApplicationsInputSchema,
  type BulkRejectApplicationsInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";
import { humanizeStage, resolveApplicationsByFilter } from "./resolve-applications-by-filter";

export const bulkRejectApplicationsAction: IrisAction<BulkRejectApplicationsInput> = {
  id: "bulk_reject_applications",
  label: "Reject candidates in bulk",
  group: "Pipeline",
  // Same pipeline operators as the single reject — recruiters + admin.
  roles: ["admin", "recruiter"],
  inputSchema: bulkRejectApplicationsInputSchema,
  // Ends every matching candidate's application — the client shows destructive
  // framing on the confirm step.
  destructive: true,
  bulk: true,

  buildPreview(params) {
    const reason = params.reason?.trim();
    return {
      summary: `Reject every candidate on this requisition at ${humanizeStage(params.fromStage)}`,
      details: [
        `Current stage: ${humanizeStage(params.fromStage)}`,
        reason ? `Reason: ${reason}` : "No reason provided",
        "This ends each matching candidate's application.",
      ],
    };
  },

  async resolve(caller, _ctx, params) {
    const entities = await resolveApplicationsByFilter(
      caller,
      params.requisitionId,
      params.fromStage,
    );
    return { entityType: "application", entities };
  },

  async execute(caller, _ctx, params) {
    const entities = await resolveApplicationsByFilter(
      caller,
      params.requisitionId,
      params.fromStage,
    );
    const reason = params.reason?.trim();
    const succeededIds: string[] = [];
    let failed = 0;
    // LOOP the real gated procedure per application; tolerate per-row failure.
    for (const entity of entities) {
      try {
        await caller.rejectApplication({
          applicationId: entity.entityId,
          ...(reason ? { reason } : {}),
        });
        succeededIds.push(entity.entityId);
      } catch {
        failed += 1;
      }
    }
    const total = entities.length;
    return {
      entityType: "application",
      entityIds: succeededIds,
      total,
      succeeded: succeededIds.length,
      failed,
      resultSummary:
        total === 0
          ? "No candidates matched this filter."
          : `Rejected ${succeededIds.length} of ${total} candidate${
              total === 1 ? "" : "s"
            }${failed > 0 ? ` (${failed} could not be rejected).` : "."}`,
    };
  },
};
