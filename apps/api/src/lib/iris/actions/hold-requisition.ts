/**
 * Iris action: hold_requisition — put an approved / posted requisition ON HOLD
 * (a reversible lifecycle change) with a human-entered reason.
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME gated
 * `setRequisitionHold` procedure a recruiter would call by hand, through the
 * in-process caller — its own REQUISITION_POST_ROLES gate + `withAudit` fire, and
 * it enforces the transition rule server-side (hold is allowed ONLY from approved
 * / posted). Iris only orchestrates it and records one provenance row. The
 * `reason` is REQUIRED (the drawer collects it); `buildPreview` names it so the
 * review card shows what will be recorded.
 */

import {
  holdRequisitionActionInputSchema,
  type HoldRequisitionActionInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const holdRequisitionAction: IrisAction<HoldRequisitionActionInput> = {
  id: "hold_requisition",
  label: "Put a requisition on hold",
  group: "Requisitions",
  // Mirrors REQUISITION_POST_ROLES — the roles that take requisitions live in the
  // app (the setRequisitionHold procedure this dispatches gates the same set).
  roles: ["admin", "hiring_manager", "recruiter"],
  inputSchema: holdRequisitionActionInputSchema,
  destructive: false,
  bulk: false,

  buildPreview(params) {
    return {
      summary: "Put this requisition on hold",
      details: [`Reason: ${params.reason.trim()}`],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated state change — its own role gate + withAudit fire and it
    // enforces the approved/posted → on_hold rule server-side.
    await caller.setRequisitionHold({
      requisitionId: params.requisitionId,
      action: "hold",
      reason: params.reason,
    });
    return {
      entityType: "requisition",
      entityId: params.requisitionId,
      resultSummary: "Put this requisition on hold.",
    };
  },
};
