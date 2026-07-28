/**
 * Iris action: create_requisition_jd — the ONE action wired for IRIS-A1.
 *
 * Creates a requisition draft and generates its JD by running the SAME two
 * gated procedures the requisition wizard uses, in order, through the passed
 * in-process caller:
 *
 *   caller.createRequisitionDraft(params)  → { requisitionId }
 *   caller.generateJdDraft({ requisitionId })
 *
 * HONESTY. Nothing here writes to the DB directly. Both procedures re-check the
 * requisition-write role gate and fire their own `withAudit` under the caller's
 * RLS tx — Iris only chains them. `inputSchema` reuses the wizard's real
 * `createRequisitionDraftInputSchema`, so the minimum-info contract Iris
 * gathers is byte-identical to what a human submits (title + locationType are
 * the required minimum; the rest keep their wizard defaults / optionality).
 */

import {
  createRequisitionDraftInputSchema,
  type CreateRequisitionDraftInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const createRequisitionJdAction: IrisAction<CreateRequisitionDraftInput> = {
  id: "create_requisition_jd",
  label: "Create requisition + JD",
  group: "Requisitions",
  // Mirrors REQUISITION_WRITE_ROLES — the roles that create requisitions in the
  // app (the createRequisitionDraft / generateJdDraft gate this chains).
  roles: ["admin", "hiring_manager"],
  // Reuse the wizard's real input contract — the minimum to create a req and
  // generate its JD, unchanged.
  inputSchema: createRequisitionDraftInputSchema,
  destructive: false,
  bulk: false,

  buildPreview(params) {
    const details: string[] = [];
    if (params.department) details.push(`Business unit: ${params.department}`);
    if (params.seniority) details.push(`Seniority: ${params.seniority}`);
    if (params.primaryLocation) {
      details.push(`Location: ${params.primaryLocation} (${params.locationType})`);
    } else {
      details.push(`Location type: ${params.locationType}`);
    }
    const openings = params.numberOfOpenings ?? 1;
    details.push(`Openings: ${openings}`);
    return {
      summary: `Create requisition “${params.title}” and generate its JD`,
      details,
    };
  },

  async execute(caller, _ctx, params) {
    // Step 1: the real gated create — its own RLS + withAudit fire, commits its
    // own tx, returns the new requisition id.
    const { requisitionId } = await caller.createRequisitionDraft(params);
    // Step 2: the real gated JD generation for that requisition.
    await caller.generateJdDraft({ requisitionId });
    return {
      entityType: "requisition",
      entityId: requisitionId,
      resultSummary: `Created requisition “${params.title}” and generated its JD.`,
    };
  },
};
