/**
 * Required-candidate-field policy (T2.1 / G05) contracts. Pure zod — the tRPC
 * surface (`apps/api`), the admin `/admin/candidate-fields` page, and the pure
 * missing-info engine all validate against these single definitions.
 *
 * The policy is a tenant's editable CONFIG over the fixed SEVEN-field Missing
 * Info CATALOG (apps/api/src/lib/missing-info.ts). The code constant stays the
 * canonical catalog — which fields are trackable and what each reads from; this
 * layer lets an org override a field's `requiredness` and the stage a missing
 * REQUIRED field gates. An org configures the catalog; it never invents fields.
 *
 * HONESTY — tracked vs gated: every field is always TRACKED in the recruiter's
 * Missing Info tracker. A field becomes a HARD GATE (advancement refused when
 * missing) only when the tenant SAVES a policy row for it with a non-null
 * `blocksAdvanceStage`. `isConfigured` tells the editor whether a field is on
 * the code default (tracked-only hint) or an enforced tenant policy.
 */

import { z } from "zod";
import { applicationStageSchema } from "./enums";
import { missingInfoRequirednessSchema } from "./recruiter-brief";

/** The seven catalog field keys the Missing Info tracker understands. FIXED —
 * mirrors MISSING_INFO_FIELD_KEYS in apps/api/src/lib/missing-info.ts. */
export const CANDIDATE_FIELD_POLICY_KEYS = [
  "expected_salary",
  "notice_period",
  "availability_date",
  "work_authorization",
  "current_location",
  "skills_confirmation",
  "education_year",
] as const;
export const candidateFieldKeySchema = z.enum(CANDIDATE_FIELD_POLICY_KEYS);
export type CandidateFieldKey = z.infer<typeof candidateFieldKeySchema>;

/**
 * One catalog field as the admin editor renders it: the code-owned catalog
 * metadata (label + data source) plus this tenant's EFFECTIVE requiredness /
 * gate (override merged over the code default) and whether that effective value
 * comes from a saved tenant policy row (`isConfigured` — enforced) or the code
 * default (`!isConfigured` — tracked, not gated).
 */
export const candidateFieldPolicyEntrySchema = z.object({
  fieldKey: candidateFieldKeySchema,
  /** Human label for the field (from the code catalog). */
  label: z.string(),
  /** Where the value is read from — the honest data-source label. */
  dataSource: z.string(),
  /** Effective requiredness for this tenant (override or code default). */
  requiredness: missingInfoRequirednessSchema,
  /** Effective gate stage, or null when the field gates nothing. */
  blocksAdvanceStage: applicationStageSchema.nullable(),
  /** The code default requiredness (for the "reset" / "differs from default" hint). */
  defaultRequiredness: missingInfoRequirednessSchema,
  /** The code default gate stage, or null. */
  defaultBlocksAdvanceStage: applicationStageSchema.nullable(),
  /** true = a saved tenant policy row drives (and ENFORCES) this field's gate;
   *  false = the code default (tracked in the tracker, NOT gated). */
  isConfigured: z.boolean(),
});
export type CandidateFieldPolicyEntry = z.infer<typeof candidateFieldPolicyEntrySchema>;

/** The set of stages a gate may point at, for the editor's select. Kept in sync
 * with the enforcement points (advance + offer-desk). All valid stages are
 * allowed; the editor scopes the sensible ones. */
export const candidateFieldGateStageSchema = applicationStageSchema;

// ─────────────────────────── getCandidateFieldPolicy ───────────────────────────

export const getCandidateFieldPolicyInputSchema = z.object({}).default({});
export const getCandidateFieldPolicyOutputSchema = z.object({
  fields: z.array(candidateFieldPolicyEntrySchema),
});
export type GetCandidateFieldPolicyOutput = z.infer<typeof getCandidateFieldPolicyOutputSchema>;

// ─────────────────────────── upsertCandidateFieldPolicy ───────────────────────────

/**
 * Admin upsert of one field's policy, keyed by (tenant, fieldKey). `fieldKey`
 * must be one of the seven catalog keys; `requiredness` in the enum;
 * `blocksAdvanceStage` a valid ApplicationStage or null. Unknowns are rejected
 * by zod before the procedure runs.
 */
export const upsertCandidateFieldPolicyInputSchema = z.object({
  fieldKey: candidateFieldKeySchema,
  requiredness: missingInfoRequirednessSchema,
  blocksAdvanceStage: applicationStageSchema.nullable().default(null),
});
export type UpsertCandidateFieldPolicyInput = z.infer<typeof upsertCandidateFieldPolicyInputSchema>;
export const upsertCandidateFieldPolicyOutputSchema = z.object({
  field: candidateFieldPolicyEntrySchema,
});
export type UpsertCandidateFieldPolicyOutput = z.infer<
  typeof upsertCandidateFieldPolicyOutputSchema
>;

// ─────────────────────────── resetCandidateFieldPolicy ───────────────────────────

/** Delete a field's policy row → the field falls back to the code default
 * (tracked, not gated). Idempotent — resetting an already-default field is a
 * no-op that still returns the current (default) entry. */
export const resetCandidateFieldPolicyInputSchema = z.object({
  fieldKey: candidateFieldKeySchema,
});
export type ResetCandidateFieldPolicyInput = z.infer<typeof resetCandidateFieldPolicyInputSchema>;
export const resetCandidateFieldPolicyOutputSchema = z.object({
  field: candidateFieldPolicyEntrySchema,
});
export type ResetCandidateFieldPolicyOutput = z.infer<
  typeof resetCandidateFieldPolicyOutputSchema
>;
