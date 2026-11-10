/**
 * PC-5 — the pure half of bulkMoveApplications (checkbox bulk advance / reject /
 * move-to-stage on the candidates-by-role list).
 *
 * The mutation itself lives in the router because it loops the SAME private
 * transitionApplicationStage core the single advance / reject procedures use
 * (so every deterministic gate, the candidate stage / closing email and the
 * partner email fire per row exactly as for a single move). This module owns the
 * decisions that need no DB: which stage a row goes to, how a per-row refusal is
 * classified, and the api_audit_logs rows that mirror the single moves.
 */

import { TRPCError } from "@trpc/server";
import {
  CLOSED_APPLICATION_STAGES,
  NEXT_PIPELINE_STAGE,
  type ApplicationStage,
  type BulkMoveAction,
  type BulkMoveSkipReason,
} from "@hireops/api-types";

export type BulkMovePlan =
  | { kind: "move"; targetStage: ApplicationStage }
  | { kind: "skip"; skipReason: BulkMoveSkipReason; message: string };

/**
 * Decide one row's target stage from the bulk action and the row's CURRENT stage
 * (read server-side, never trusted from the client).
 */
export function planBulkMove(
  action: BulkMoveAction,
  currentStage: ApplicationStage,
  targetStage: ApplicationStage | undefined,
): BulkMovePlan {
  if (CLOSED_APPLICATION_STAGES.has(currentStage)) {
    return { kind: "skip", skipReason: "closed", message: "Application is already closed." };
  }
  let target: ApplicationStage | undefined;
  if (action === "advance_next") {
    target = NEXT_PIPELINE_STAGE[currentStage];
    if (!target) {
      return {
        kind: "skip",
        skipReason: "no_next_stage",
        message: "There is no next stage to advance to.",
      };
    }
  } else if (action === "reject") {
    target = "recruiter_rejected";
  } else {
    target = targetStage;
    if (!target) {
      // The input schema refuses this; defensive.
      return { kind: "skip", skipReason: "error", message: "No target stage given." };
    }
  }
  if (target === currentStage) {
    return {
      kind: "skip",
      skipReason: "already_at_stage",
      message: "Already at the target stage.",
    };
  }
  return { kind: "move", targetStage: target };
}

/**
 * Classify an error thrown by transitionApplicationStage for one row. Its
 * deterministic gates throw BAD_REQUEST with a human message (HR-round
 * assessment, candidate-field policy, already-at-stage); NOT_FOUND means the row
 * is not visible. Anything else is an unexpected per-row error.
 */
export function classifyBulkMoveError(err: unknown): {
  skipReason: BulkMoveSkipReason;
  message: string;
} {
  if (err instanceof TRPCError) {
    if (err.code === "NOT_FOUND") return { skipReason: "not_found", message: err.message };
    if (err.code === "BAD_REQUEST") {
      return /already at stage/i.test(err.message)
        ? { skipReason: "already_at_stage", message: err.message }
        : { skipReason: "gate_blocked", message: err.message };
    }
    return { skipReason: "error", message: err.message };
  }
  return { skipReason: "error", message: "Unexpected error moving this application." };
}

/**
 * The audit action a single move would have recorded — so per-row bulk audit
 * rows are indistinguishable in kind from single moves (reports keep counting
 * "reject_application" as ended and "advance_application" as moved).
 */
export function singleMoveAuditAction(targetStage: ApplicationStage): string {
  return targetStage === "recruiter_rejected" ? "reject_application" : "advance_application";
}

/** The per-row api_audit_logs input_json, mirroring withAudit's shape. */
export function bulkMoveAuditInput(args: {
  applicationId: string;
  targetStage: ApplicationStage;
  reason: string | null;
  bulkRequestId: string;
}): Record<string, unknown> {
  const action = singleMoveAuditAction(args.targetStage);
  const input: Record<string, unknown> = { applicationId: args.applicationId };
  if (action === "advance_application") input.targetStage = args.targetStage;
  if (args.reason) input.reason = args.reason;
  input.bulk = true;
  input.bulkRequestId = args.bulkRequestId;
  return { action, input };
}
