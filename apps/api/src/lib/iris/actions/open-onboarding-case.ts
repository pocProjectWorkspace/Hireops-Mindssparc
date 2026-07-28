/**
 * Iris action: open_onboarding_case (IRIS-B1) — open (or backfill) an
 * onboarding case for a candidate's application.
 *
 * HONESTY. Nothing here writes to the DB directly. `execute` runs the SAME
 * gated `createOnboardingCaseForApplication` procedure the manual/backfill path
 * uses, through the in-process caller — its own RLS + `withAudit(…)` and the
 * idempotent "case already exists" behaviour fire exactly as a human's call
 * would. Iris only orchestrates the one procedure and records one provenance
 * row. `inputSchema` reuses the procedure's real
 * `createOnboardingCaseForApplicationInputSchema` (applicationId only).
 *
 * The provenance row is stamped entityType "application" (the SOURCE application
 * id), so the AI-assisted pill lands on the application the recruiter sees — not
 * the onboarding case row.
 */

import {
  createOnboardingCaseForApplicationInputSchema,
  type CreateOnboardingCaseForApplicationInput,
} from "@hireops/api-types";
import type { IrisAction } from "../registry";

export const openOnboardingCaseAction: IrisAction<CreateOnboardingCaseForApplicationInput> = {
  id: "open_onboarding_case",
  label: "Open onboarding case",
  group: "Onboarding",
  // Reuse the procedure's real input contract — applicationId only.
  inputSchema: createOnboardingCaseForApplicationInputSchema,
  destructive: false,
  bulk: false,

  buildPreview() {
    return {
      summary: "Open an onboarding case for this candidate",
      details: ["Skips creation if a case already exists for this application."],
    };
  },

  async execute(caller, _ctx, params) {
    // The real gated onboarding-case creation — its own RLS + withAudit fire.
    const res = await caller.createOnboardingCaseForApplication(params);
    return {
      // Land the provenance on the SOURCE application so the pill shows there.
      entityType: "application",
      entityId: params.applicationId,
      resultSummary: res.created
        ? `Opened an onboarding case (geography ${res.geographyCode}).`
        : "An onboarding case already exists for this candidate.",
    };
  },
};
