/**
 * Iris action: request_documents — ask ONE candidate to provide one or more
 * document types (a 'requested' row per type the candidate uploads against, the
 * same pull model onboarding document collection uses).
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME gated
 * `requestApplicationDocuments` procedure an HR-ops user would call by hand,
 * through the in-process caller — its own HR_OPS_DOC_ROLES gate + `withAudit`
 * fire, and it validates the document type ids server-side + is idempotent per
 * (tenant, application, type). Iris only orchestrates it and records one
 * provenance row. `inputSchema` reuses the procedure's real input contract, so
 * the drawer's multi-select supplies exactly what a human submits.
 */

import {
  requestApplicationDocumentsInputSchema,
  type RequestApplicationDocumentsInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const requestDocumentsAction: IrisAction<RequestApplicationDocumentsInput> = {
  id: "request_documents",
  label: "Request documents from a candidate",
  group: "Documents",
  // Mirrors HR_OPS_DOC_ROLES — the roles that run the Documents & verification
  // surface (the requestApplicationDocuments procedure this dispatches gates the
  // same set).
  roles: ["admin", "hr_ops"],
  inputSchema: requestApplicationDocumentsInputSchema,
  destructive: false,
  bulk: false,

  buildPreview(params) {
    const n = params.documentTypeIds.length;
    return {
      summary: "Request documents from this candidate",
      details: [`${n} document type${n === 1 ? "" : "s"} requested`],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated request — its own HR_OPS_DOC_ROLES gate + withAudit fire and
    // it inserts one 'requested' row per valid type. Iris only orchestrates it.
    await caller.requestApplicationDocuments(params);
    return {
      entityType: "application",
      entityId: params.applicationId,
      resultSummary: "Requested documents from this candidate.",
    };
  },
};
