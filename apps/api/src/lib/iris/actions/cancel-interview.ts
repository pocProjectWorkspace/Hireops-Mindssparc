/**
 * Iris action: cancel_interview — cancel ONE scheduled interview with a
 * human-entered reason (and notify the candidate). DESTRUCTIVE: the drawer shows
 * the calm destructive framing before Confirm.
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME gated
 * `cancelInterview` procedure a recruiter / hiring manager would call by hand,
 * through the in-process caller — its own INTERVIEW_MANAGE_ROLES gate + `withAudit`
 * fire, and it flips the interview to `cancelled` + best-effort enqueues the
 * candidate cancellation email. Iris only orchestrates it and records one
 * provenance row. `inputSchema` reuses the procedure's real input contract; the
 * `reason` is REQUIRED (the drawer collects it) and `buildPreview` names it so the
 * destructive review card shows what will be recorded.
 */

import { cancelInterviewInputSchema, type CancelInterviewInput } from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const cancelInterviewAction: IrisAction<CancelInterviewInput> = {
  id: "cancel_interview",
  label: "Cancel an interview",
  group: "Interviews",
  // Mirrors INTERVIEW_MANAGE_ROLES — the roles that schedule / cancel interviews
  // in the app (the cancelInterview procedure this dispatches gates the same set).
  roles: ["admin", "hiring_manager", "recruiter"],
  inputSchema: cancelInterviewInputSchema,
  // Cancelling a scheduled interview notifies the candidate → destructive framing.
  destructive: true,
  bulk: false,

  buildPreview(params) {
    return {
      summary: "Cancel this interview",
      details: [`Reason: ${params.reason.trim()}`],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated cancellation — its own INTERVIEW_MANAGE_ROLES gate + withAudit
    // fire and it enqueues the candidate cancellation notice. Iris only
    // orchestrates it.
    await caller.cancelInterview(params);
    return {
      entityType: "interview",
      entityId: params.interviewId,
      resultSummary: "Cancelled this interview.",
    };
  },
};
