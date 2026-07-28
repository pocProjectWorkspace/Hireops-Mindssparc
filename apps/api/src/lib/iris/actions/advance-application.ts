/**
 * Iris action: advance_application (IRIS-B1) — move a candidate's application
 * forward to a target pipeline stage.
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME
 * gated `advanceApplication` procedure a recruiter uses in triage, through the
 * in-process caller — its own RLS + `withAudit("advance_application", …)` and
 * the deterministic forward-stage gates (HR-round assessment, candidate-field
 * policy) all fire exactly as a human's call would. Iris only orchestrates one
 * procedure and records one provenance row. `inputSchema` reuses the procedure's
 * real `advanceApplicationInputSchema`, byte-identical to what a human submits.
 */

import { advanceApplicationInputSchema, type AdvanceApplicationInput } from "@hireops/api-types";
import type { IrisAction } from "../registry";

/** Sentence-case a stage token for a human-readable preview (e.g.
 * "offer_drafted" → "Offer drafted"). Pure display sugar, no data invented. */
function humanizeStage(stage: string): string {
  const words = stage.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const advanceApplicationAction: IrisAction<AdvanceApplicationInput> = {
  id: "advance_application",
  label: "Advance candidate",
  group: "Pipeline",
  // Reuse the triage procedure's real input contract, unchanged.
  inputSchema: advanceApplicationInputSchema,
  destructive: false,
  bulk: false,

  buildPreview(params) {
    const details: string[] = [`New stage: ${humanizeStage(params.targetStage)}`];
    if (params.reason?.trim()) details.push(`Reason: ${params.reason.trim()}`);
    return {
      summary: `Advance this candidate to ${humanizeStage(params.targetStage)}`,
      details,
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated stage transition — its own RLS + withAudit + forward-stage
    // gates fire; returns the from/to stages and the transition id.
    const res = await caller.advanceApplication(params);
    return {
      entityType: "application",
      entityId: res.applicationId,
      resultSummary: `Advanced the candidate from ${humanizeStage(res.fromStage)} to ${humanizeStage(
        res.toStage,
      )}.`,
    };
  },
};
