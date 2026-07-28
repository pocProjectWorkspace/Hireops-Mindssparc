import { z } from "zod";
import { applicationStageSchema } from "./enums";

/**
 * Iris — user-invoked TRANSACTIONAL assistant (IRIS-A1). Shared zod + types
 * for the three procedures that back the menu-driven path:
 *
 *   irisListActions   — the serialisable, whitelist-only action menu.
 *   irisExecute       — the post-confirm commit call. Dispatches through a
 *                       typed action registry into the SAME gated tRPC
 *                       procedure a human uses (its own RLS + withAudit fire);
 *                       records one assistant_actions provenance row.
 *   irisGetProvenance — reads those provenance rows back to drive the future
 *                       "AI-assisted" pill.
 *
 * HONESTY: Iris never writes through a side path. These schemas describe the
 * ORCHESTRATION + PROVENANCE contract; the actual mutation contract is the
 * underlying procedure's own input/output schema, unchanged.
 */

// ─────────────── irisListActions ───────────────

/**
 * One entry in the serialisable action menu. Whitelist-only: the menu is
 * exactly the registry, nothing more. The action's input CONTRACT stays
 * server-side (the registry's zod `inputSchema`); a later client ticket adds
 * whatever form-rendering payload it needs. This wire shape is intentionally
 * the minimal `{id,label,group,destructive,bulk}` the menu path requires, plus
 * the per-action `roles` (IRIS-B1.1) so a client can reflect who may run each
 * action. The server ALREADY filters this menu to the caller's roles — `roles`
 * is descriptive metadata, never the enforcement point (that stays server-side
 * on irisPreview/irisExecute).
 */
export const irisActionMenuItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string(),
  destructive: z.boolean(),
  bulk: z.boolean(),
  roles: z.array(z.string()),
});
export type IrisActionMenuItem = z.infer<typeof irisActionMenuItemSchema>;

export const irisListActionsInputSchema = z.object({}).optional();
export const irisListActionsOutputSchema = z.object({
  actions: z.array(irisActionMenuItemSchema),
});
export type IrisListActionsOutput = z.infer<typeof irisListActionsOutputSchema>;

// ─────────────── irisSearchApplications ───────────────

/**
 * A purpose-built, correctly-gated read for the Iris application picker
 * (IRIS-B1.1). The pipeline/onboarding actions (advance/reject/open onboarding)
 * are operated by recruiters + HR-ops, who are NOT in the candidate-triage read
 * set (listCandidates). Rather than widen that procedure's gate, this lean read
 * is gated to the UNION of the pipeline action roles and returns just what the
 * picker renders: the application id + candidate name + position + current
 * stage, RLS-scoped to the caller's tenant.
 */
export const irisSearchApplicationsInputSchema = z.object({
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type IrisSearchApplicationsInput = z.infer<typeof irisSearchApplicationsInputSchema>;

export const irisApplicationSearchRowSchema = z.object({
  applicationId: z.string().uuid(),
  // candidateId is carried so the picker's caller can deep-link to the candidate
  // detail drawer (which opens by candidateId) after an action — the fields the
  // picker DISPLAYS are candidateName + positionTitle + currentStage.
  candidateId: z.string().uuid(),
  candidateName: z.string().nullable(),
  positionTitle: z.string().nullable(),
  currentStage: applicationStageSchema,
});
export type IrisApplicationSearchRow = z.infer<typeof irisApplicationSearchRowSchema>;

export const irisSearchApplicationsOutputSchema = z.object({
  rows: z.array(irisApplicationSearchRowSchema),
});
export type IrisSearchApplicationsOutput = z.infer<typeof irisSearchApplicationsOutputSchema>;

// ─────────────── irisPreview ───────────────

/**
 * Resolve the REAL server-side preview the user reviews BEFORE they confirm.
 * Read-only: it looks the whitelisted action up, validates `params` against the
 * action's OWN input contract, and returns the registry's `buildPreview`
 * result — the SAME preview logic irisExecute's action would show, never a
 * client-side re-implementation. `params` is `unknown` at the transport
 * boundary (the action's schema validates it server-side, exactly like
 * irisExecute). No write, no withAudit; the commit stays irisExecute.
 */
export const irisPreviewInputSchema = z.object({
  actionId: z.string().min(1),
  params: z.unknown(),
});
export type IrisPreviewInput = z.infer<typeof irisPreviewInputSchema>;

/**
 * One concrete entity a FILTER-based bulk action (IRIS-B2) resolves to, shown to
 * the user in the review step BEFORE they confirm the batch. `label` is a
 * human-readable line (e.g. "Asha Rao — Recruiter review"). Single-entity actions
 * never populate this.
 */
export const irisAffectedEntitySchema = z.object({
  entityId: z.string().uuid(),
  label: z.string(),
});
export type IrisAffectedEntity = z.infer<typeof irisAffectedEntitySchema>;

export const irisPreviewOutputSchema = z.object({
  summary: z.string(),
  details: z.array(z.string()),
  /**
   * The EXACT set a bulk action would act on, resolved server-side from the
   * filter (IRIS-B2). The client renders this list + count so the user confirms
   * an explicit N. Omitted/empty for single-entity actions.
   */
  affected: z.array(irisAffectedEntitySchema).optional(),
  affectedCount: z.number().int().min(0).optional(),
});
export type IrisPreviewOutput = z.infer<typeof irisPreviewOutputSchema>;

// ─────────────── irisExecute ───────────────

/**
 * The post-confirm commit call. `params` is validated by the registered
 * action's OWN input schema server-side (whitelist-only dispatch), so it is
 * `unknown` at the transport boundary.
 */
export const irisExecuteInputSchema = z.object({
  actionId: z.string().min(1),
  params: z.unknown(),
});
export type IrisExecuteInput = z.infer<typeof irisExecuteInputSchema>;

export const irisExecuteOutputSchema = z.object({
  ok: z.literal(true),
  entityType: z.string(),
  // For a single action this is the affected entity; for a bulk action it is the
  // FIRST succeeded entity (or null) so the drawer's single done-link still works.
  entityId: z.string().uuid().nullable(),
  resultSummary: z.string(),
  // ─── bulk-action (IRIS-B2) fields — omitted for single-entity actions ───
  /** Every succeeded entity id — one assistant_actions provenance row was
   * recorded per id, so each candidate carries the AI-assisted pill. */
  entityIds: z.array(z.string().uuid()).optional(),
  /** The resolved batch size the action attempted. */
  total: z.number().int().min(0).optional(),
  /** How many of `total` committed successfully. */
  succeeded: z.number().int().min(0).optional(),
  /** How many of `total` failed (partial failure is tolerated + reported). */
  failed: z.number().int().min(0).optional(),
});
export type IrisExecuteOutput = z.infer<typeof irisExecuteOutputSchema>;

// ─────────────── irisGetProvenance ───────────────

export const irisGetProvenanceInputSchema = z.object({
  entityType: z.string().min(1),
  entityIds: z.array(z.string().uuid()).min(1).max(200),
});
export type IrisGetProvenanceInput = z.infer<typeof irisGetProvenanceInputSchema>;

export const irisProvenanceRowSchema = z.object({
  entityId: z.string().uuid(),
  assistant: z.string(),
  actionId: z.string(),
  confirmedByUserId: z.string().uuid().nullable(),
  /** Resolved display name of the confirming human, when readable; else omitted. */
  confirmedByLabel: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type IrisProvenanceRow = z.infer<typeof irisProvenanceRowSchema>;

export const irisGetProvenanceOutputSchema = z.object({
  rows: z.array(irisProvenanceRowSchema),
});
export type IrisGetProvenanceOutput = z.infer<typeof irisGetProvenanceOutputSchema>;

// ─────────────── bulk pipeline actions (IRIS-B2) ───────────────

/**
 * Filter-based BULK advance (IRIS-B2). The user names a requisition + the
 * CURRENT stage to act on; the action resolves that filter to the concrete set
 * of matching applications and, after confirm, LOOPS the real per-entity gated
 * `advanceApplication` procedure over each (its own RLS + withAudit fires per
 * row). This schema is the FILTER contract, not a bulk write path.
 */
export const bulkAdvanceApplicationsInputSchema = z.object({
  requisitionId: z.string().uuid(),
  fromStage: applicationStageSchema,
  targetStage: applicationStageSchema,
  reason: z.string().max(500).optional(),
});
export type BulkAdvanceApplicationsInput = z.infer<typeof bulkAdvanceApplicationsInputSchema>;

/**
 * Filter-based BULK reject (IRIS-B2). DESTRUCTIVE: ends every matching
 * application. Same filter → resolve → loop `rejectApplication` (per-row RLS +
 * withAudit) shape as the bulk advance.
 */
export const bulkRejectApplicationsInputSchema = z.object({
  requisitionId: z.string().uuid(),
  fromStage: applicationStageSchema,
  reason: z.string().max(500).optional(),
});
export type BulkRejectApplicationsInput = z.infer<typeof bulkRejectApplicationsInputSchema>;

// ─────────────── irisResolveIntent (IRIS-A3) ───────────────

/**
 * irisResolveIntent (IRIS-A3) — the natural-language layer over the SAME
 * menu-driven pipeline. Free text in; a PROPOSED whitelisted action + extracted
 * DRAFT params out. It is a resolver, never an executor:
 *
 *   - It only ever PROPOSES one of the CALLER's role-eligible whitelisted
 *     actions (the exact same set irisListActions returns for this caller); an
 *     ineligible / hallucinated actionId is nulled server-side.
 *   - It NEVER resolves a concrete entity id. For application / requisition
 *     targets it returns a free-text `candidateQuery` / `requisitionQuery` HINT
 *     that SEEDS the drawer's picker — the human selects the concrete entity.
 *     Any uuid-looking value the model tries to smuggle into an id param is
 *     stripped.
 *   - The proposal flows into the UNCHANGED irisPreview → confirm → irisExecute
 *     path. Nothing here writes or auto-executes; the ai_usage_logs cost row
 *     (feature "iris_intent") is the only side effect, and it degrades to a
 *     calm "use the menu" message when the tenant's AI is off / erroring.
 */
export const irisResolveIntentInputSchema = z.object({
  /** The user's free-text request. Bounded so a paste can't balloon the prompt. */
  text: z.string().min(1).max(1000),
  /** Optional page context so the resolver can disambiguate ("this candidate"). */
  context: z
    .object({
      route: z.string().max(500).optional(),
      entityType: z.string().max(100).optional(),
      entityId: z.string().max(200).optional(),
    })
    .optional(),
});
export type IrisResolveIntentInput = z.infer<typeof irisResolveIntentInputSchema>;

/**
 * The picker SEEDS the resolver returns — free-text search phrases, NEVER ids.
 * `candidateQuery` seeds the application picker; `requisitionQuery` seeds the
 * requisition picker. The human still selects + confirms the concrete entity.
 */
export const irisResolveIntentHintsSchema = z.object({
  candidateQuery: z.string().optional(),
  requisitionQuery: z.string().optional(),
});
export type IrisResolveIntentHints = z.infer<typeof irisResolveIntentHintsSchema>;

export const irisResolveIntentOutputSchema = z.object({
  /**
   * The PROPOSED action id — guaranteed to be one of the caller's role-eligible
   * whitelisted ids, or null when the model proposed nothing eligible. The
   * client opens this action's existing form; it is never dispatched from here.
   */
  actionId: z.string().nullable(),
  /**
   * DRAFT scalar params (stages, reasons, title, …) that PREFILL the action's
   * form. Never any concrete entity id — id-shaped values are stripped server
   * side. Empty when nothing scalar was extracted.
   */
  params: z.record(z.string(), z.unknown()),
  /** Free-text picker seeds (never ids); see irisResolveIntentHintsSchema. */
  hints: irisResolveIntentHintsSchema,
  /** A question shown in the chat area when the model needs the user to refine. */
  clarifyingQuestion: z.string().nullable().optional(),
  /** A calm note shown when no action was proposed (incl. the degrade path). */
  message: z.string().nullable().optional(),
});
export type IrisResolveIntentOutput = z.infer<typeof irisResolveIntentOutputSchema>;
