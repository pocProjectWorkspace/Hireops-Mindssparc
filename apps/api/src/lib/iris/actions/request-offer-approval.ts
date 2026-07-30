/**
 * Iris action: request_offer_approval — route an existing drafted / extended
 * offer into the approval queue for sign-off (a low-risk, reversible routing).
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME gated
 * `requestOfferApproval` procedure the comp desk would call by hand, through the
 * in-process caller — its own COMP_DESK_ROLES gate + `withAudit` fire, and it
 * enforces the routing rules server-side (offer must be drafted/extended, above
 * the comp band, and not already pending/approved). Iris only orchestrates it and
 * records one provenance row. `inputSchema` reuses the procedure's real input
 * contract (the offer id).
 */

import {
  requestOfferApprovalInputSchema,
  type RequestOfferApprovalInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const requestOfferApprovalAction: IrisAction<RequestOfferApprovalInput> = {
  id: "request_offer_approval",
  label: "Send an offer for approval",
  group: "Offers",
  // Mirrors COMP_DESK_ROLES — the roles that operate the comp & offer desk (the
  // requestOfferApproval procedure this dispatches gates the same set).
  roles: ["admin", "hr_ops"],
  inputSchema: requestOfferApprovalInputSchema,
  destructive: false,
  bulk: false,

  buildPreview() {
    return {
      summary: "Send this offer for approval",
      details: ["Routes the offer into the approval queue for sign-off."],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated routing — its own COMP_DESK_ROLES gate + withAudit fire and
    // it opens (or surfaces) the approval request. Iris only orchestrates it.
    await caller.requestOfferApproval(params);
    return {
      entityType: "offer",
      entityId: params.offerId,
      resultSummary: "Sent this offer for approval.",
    };
  },
};
