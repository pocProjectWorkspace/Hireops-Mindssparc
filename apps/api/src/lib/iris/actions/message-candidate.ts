/**
 * Iris action: message_candidate — send ONE real, human-confirmed message to a
 * candidate.
 *
 * The drawer DRAFTS the email via irisDraftCandidateMessage (AI proposes only),
 * fills the editable subject + body from that draft, the human edits freely, and
 * on Confirm this action runs the SAME gated `messageCandidate` procedure a
 * recruiter would call by hand:
 *
 *   caller.messageCandidate({ applicationId, subject, body })
 *     → fetchTransitionEmailContext + enqueueNotification (candidate.agent_message)
 *
 * HONESTY. Nothing here writes to the DB directly. `messageCandidate` re-checks
 * the recruiter-surface role gate and fires its own `withAudit` under the
 * caller's RLS tx — Iris only orchestrates it and records one provenance row.
 * `inputSchema` is the FINAL, human-confirmed message; the AI only proposes a
 * draft to prefill it. Sending requires the explicit human Confirm.
 */

import { messageCandidateInputSchema, type MessageCandidateInput } from "@hireops/api-types";
import type { IrisAction } from "../registry";

/** How much of the body to echo into the pre-confirm preview. */
const BODY_SNIPPET = 160;

export const messageCandidateAction: IrisAction<MessageCandidateInput> = {
  id: "message_candidate",
  label: "Message a candidate",
  group: "Communication",
  // Mirrors RECRUITER_SURFACE_ROLES — the roles that message candidates in the
  // app (the messageCandidate procedure this dispatches gates the same set).
  roles: ["admin", "recruiter"],
  inputSchema: messageCandidateInputSchema,
  destructive: false,
  bulk: false,

  buildPreview(params) {
    const snippet =
      params.body.length > BODY_SNIPPET ? `${params.body.slice(0, BODY_SNIPPET)}…` : params.body;
    return {
      summary: "Message this candidate",
      details: [`Subject: ${params.subject}`, snippet],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated send — its own recruiter-surface gate + withAudit fire, and
    // it enqueues one candidate notification. Iris only orchestrates it.
    await caller.messageCandidate(params);
    return {
      entityType: "application",
      entityId: params.applicationId,
      resultSummary: "Sent a message to this candidate.",
    };
  },
};
