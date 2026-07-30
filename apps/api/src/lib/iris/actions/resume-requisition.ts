/**
 * Iris action: resume_requisition — take a requisition OFF hold (the reverse of
 * hold_requisition), back to its active status.
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME gated
 * `setRequisitionHold` procedure a recruiter would call by hand, through the
 * in-process caller — its own REQUISITION_POST_ROLES gate + `withAudit` fire, and
 * it enforces the transition rule server-side (resume is allowed ONLY from
 * on_hold; the server picks the target status — posted if the requisition has a
 * public slug, else approved — and clears the hold reason). Iris only orchestrates
 * it and records one provenance row.
 */

import {
  resumeRequisitionActionInputSchema,
  type ResumeRequisitionActionInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const resumeRequisitionAction: IrisAction<ResumeRequisitionActionInput> = {
  id: "resume_requisition",
  label: "Resume a requisition",
  group: "Requisitions",
  // Mirrors REQUISITION_POST_ROLES — same set hold_requisition uses.
  roles: ["admin", "hiring_manager", "recruiter"],
  inputSchema: resumeRequisitionActionInputSchema,
  destructive: false,
  bulk: false,

  buildPreview() {
    return {
      summary: "Resume this requisition (back to active)",
      details: ["Clears the hold and returns it to its active status."],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated state change — its own role gate + withAudit fire and it
    // enforces the on_hold → posted/approved rule server-side.
    await caller.setRequisitionHold({
      requisitionId: params.requisitionId,
      action: "resume",
    });
    return {
      entityType: "requisition",
      entityId: params.requisitionId,
      resultSummary: "Resumed this requisition.",
    };
  },
};
