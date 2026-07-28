/**
 * Iris action: reject_application (IRIS-B1) — end a candidate's application
 * (transition to recruiter_rejected). DESTRUCTIVE: the drawer must show the
 * preview with a clear, calm destructive framing before Confirm.
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME
 * gated `rejectApplication` procedure a recruiter uses in triage, through the
 * in-process caller — its own RLS + `withAudit("reject_application", …)` fire
 * exactly as a human's call would. Iris only orchestrates the one procedure and
 * records one provenance row. `inputSchema` reuses the procedure's real
 * `rejectApplicationInputSchema`, unchanged.
 */

import { rejectApplicationInputSchema, type RejectApplicationInput } from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const rejectApplicationAction: IrisAction<RejectApplicationInput> = {
  id: "reject_application",
  label: "Reject candidate",
  group: "Pipeline",
  // Reuse the triage procedure's real input contract, unchanged.
  inputSchema: rejectApplicationInputSchema,
  // Ends the candidate's application — the client shows destructive framing.
  destructive: true,
  bulk: false,

  buildPreview(params) {
    const reason = params.reason?.trim();
    return {
      summary: "Reject this candidate's application",
      details: [reason ? `Reason: ${reason}` : "No reason provided"],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated reject transition — its own RLS + withAudit fire.
    const res = await caller.rejectApplication(params);
    return {
      entityType: "application",
      entityId: res.applicationId,
      resultSummary: "Rejected this candidate's application.",
    };
  },
};
