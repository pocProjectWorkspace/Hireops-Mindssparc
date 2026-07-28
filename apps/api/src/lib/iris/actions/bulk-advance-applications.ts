/**
 * Iris action: bulk_advance_applications (IRIS-B2) — FILTER-based bulk advance.
 * The user names a requisition + the CURRENT stage; Iris resolves that filter to
 * the concrete set of matching applications, PREVIEWS the exact count + list, and
 * only after Confirm LOOPS the real per-entity gated `advanceApplication`
 * procedure over each one.
 *
 * HONESTY. Bulk is a LOOP of the real gated procedure a recruiter uses in triage,
 * not a special bulk write. Every iteration runs advanceApplication through the
 * in-process caller — its own RLS + `withAudit("advance_application", …)` and the
 * deterministic forward-stage gates fire per row, and irisExecute records one
 * assistant_actions provenance row per succeeded application (so each candidate
 * carries the AI-assisted pill). Partial failure is TOLERATED: one bad row is
 * counted in `failed` and the batch continues.
 */

import {
  bulkAdvanceApplicationsInputSchema,
  type BulkAdvanceApplicationsInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";
import { humanizeStage, resolveApplicationsByFilter } from "./resolve-applications-by-filter";

export const bulkAdvanceApplicationsAction: IrisAction<BulkAdvanceApplicationsInput> = {
  id: "bulk_advance_applications",
  label: "Advance candidates in bulk",
  group: "Pipeline",
  // Same pipeline operators as the single advance — recruiters + admin.
  roles: ["admin", "recruiter"],
  inputSchema: bulkAdvanceApplicationsInputSchema,
  destructive: false,
  bulk: true,

  // Pure: summarises the FILTER. The exact affected set comes from `resolve`,
  // which irisPreview surfaces alongside this summary.
  buildPreview(params) {
    const details: string[] = [
      `Current stage: ${humanizeStage(params.fromStage)}`,
      `New stage: ${humanizeStage(params.targetStage)}`,
    ];
    if (params.reason?.trim()) details.push(`Reason: ${params.reason.trim()}`);
    return {
      summary: `Advance every candidate on this requisition at ${humanizeStage(
        params.fromStage,
      )} to ${humanizeStage(params.targetStage)}`,
      details,
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
        await caller.advanceApplication({
          applicationId: entity.entityId,
          targetStage: params.targetStage,
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
          : `Advanced ${succeededIds.length} of ${total} candidate${
              total === 1 ? "" : "s"
            } to ${humanizeStage(params.targetStage)}${
              failed > 0 ? ` (${failed} could not be advanced).` : "."
            }`,
    };
  },
};
