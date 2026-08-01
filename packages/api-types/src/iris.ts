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

// ─────────────── per-role Iris action policy (T-POLICY) ───────────────

/**
 * Per-tenant, per-role Iris action policy. A DENY-OVERLAY on each action's
 * baked-in static `roles`: it can only NARROW who may run an action, never
 * widen. An UNCONFIGURED tenant (no stored `irisPolicy`, or a malformed / future
 * block) resolves to the empty overlay and is BYTE-IDENTICAL to today's
 * behaviour. Mirrors the `resolveAiBudget` house pattern: a versioned zod block
 * stored as a sibling key under `tenants.settings`, resolved leniently.
 *
 * `disabledRoles[actionId]` lists the roles for which that action is turned OFF.
 * A role NOT in an action's static `roles` can never be enabled, so listing it
 * here is a no-op (the effective set is `staticRoles \ disabledRoles`).
 */
export const IRIS_POLICY_VERSION = "iris-policy-v1";

export const irisPolicySchema = z.object({
  version: z.literal(IRIS_POLICY_VERSION).default(IRIS_POLICY_VERSION),
  /** action id -> roles for which the action is DISABLED. Missing/empty = today's behaviour. */
  disabledRoles: z.record(z.string(), z.array(z.string())).default({}),
});
export type IrisPolicy = z.infer<typeof irisPolicySchema>;

export function defaultIrisPolicy(): IrisPolicy {
  return irisPolicySchema.parse({});
}

/**
 * Merge a raw stored `irisPolicy` block (partial / unknown / absent) with
 * defaults, returning a complete validated policy. Malformed / future blocks
 * fall back to the empty overlay rather than throwing — same lenient discipline
 * as `resolveAiBudget`, so a bad block never silently WIDENS access.
 */
export function resolveIrisPolicy(raw: unknown): IrisPolicy {
  const parsed = irisPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultIrisPolicy();
}

/** Effective roles for an action after the deny-overlay (pure; used by filter + gate). */
export function irisActionAllowedRoles(
  actionId: string,
  staticRoles: readonly string[],
  policy: IrisPolicy,
): string[] {
  const disabled = new Set(policy.disabledRoles[actionId] ?? []);
  return staticRoles.filter((r) => !disabled.has(r));
}

// ─── admin get/update Iris policy (T-POLICY editor I/O) ───

/**
 * getIrisPolicy — the admin editor's read. Returns the resolved policy PLUS the
 * FULL action catalog (each action's static `roles` included, NOT role-filtered
 * to the admin caller) so the matrix can render every action × role cell.
 */
export const getIrisPolicyInputSchema = z.object({}).optional();
export const getIrisPolicyOutputSchema = z.object({
  policy: irisPolicySchema,
  actions: z.array(irisActionMenuItemSchema),
});
export type GetIrisPolicyOutput = z.infer<typeof getIrisPolicyOutputSchema>;

export const updateIrisPolicyInputSchema = z.object({
  policy: irisPolicySchema,
});
export type UpdateIrisPolicyInput = z.infer<typeof updateIrisPolicyInputSchema>;

export const updateIrisPolicyOutputSchema = z.object({
  policy: irisPolicySchema,
});
export type UpdateIrisPolicyOutput = z.infer<typeof updateIrisPolicyOutputSchema>;

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

// ─────────────── message_candidate (Iris Communication action) ───────────────

/**
 * messageCandidate — the REAL, human-confirmed candidate message send. A general
 * gated procedure introduced for the Iris `message_candidate` action but callable
 * by any recruiter surface: the caller supplies the FINAL subject + body (Iris may
 * DRAFT them via irisDraftCandidateMessage, but a human edits + confirms — AI never
 * sends). The procedure loads the real application context and enqueues ONE
 * candidate notification (candidate.agent_message), the SAME rails
 * `requestMissingInfo` uses. This is the effectful CONFIRM step; the draft below
 * only proposes.
 */
export const messageCandidateInputSchema = z.object({
  applicationId: z.string().uuid(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});
export type MessageCandidateInput = z.infer<typeof messageCandidateInputSchema>;

export const messageCandidateOutputSchema = z.object({
  ok: z.literal(true),
  applicationId: z.string().uuid(),
  /** The enqueued notification_outbox row id (the real send the worker delivers). */
  notificationOutboxId: z.string().uuid(),
});
export type MessageCandidateOutput = z.infer<typeof messageCandidateOutputSchema>;

/**
 * irisDraftCandidateMessage — AI DRAFTS a candidate message; PROPOSES only. Given
 * an application + the recruiter's free-text intent, the tenant's LLM composes a
 * short, professional email grounded ONLY in the real application context (name,
 * role, company) + that intent. It returns `{ subject, body }` to PREFILL the
 * drawer's EDITABLE fields — nothing is sent here. Cost auto-logs to ai_usage_logs
 * (feature "iris_message_draft"); it DEGRADES to a deterministic templated draft
 * when the tenant's AI is off / erroring, so the flow always works.
 */
export const irisDraftCandidateMessageInputSchema = z.object({
  applicationId: z.string().uuid(),
  /** The recruiter's free-text steer for the message (what to say). */
  intent: z.string().min(1).max(500),
});
export type IrisDraftCandidateMessageInput = z.infer<typeof irisDraftCandidateMessageInputSchema>;

export const irisDraftCandidateMessageOutputSchema = z.object({
  /** The drafted subject (bounded to the send contract's 200-char limit). */
  subject: z.string().min(1).max(200),
  /** The drafted body (bounded to the send contract's 4000-char limit). */
  body: z.string().min(1).max(4000),
});
export type IrisDraftCandidateMessageOutput = z.infer<typeof irisDraftCandidateMessageOutputSchema>;

// ─────────────── setRequisitionHold (Iris hold / resume) ───────────────

/**
 * setRequisitionHold — the REAL, gated requisition HOLD / RESUME state change.
 * A general human-callable procedure (introduced for the Iris `hold_requisition`
 * / `resume_requisition` actions, but a plain recruiter surface too): it flips a
 * requisition's lifecycle status and stores/clears the human-entered hold reason,
 * nothing else (no effect on applications / offers). It is the effectful CONFIRM
 * step behind the two Iris actions; the transition rules are enforced SERVER-side:
 *
 *   - hold   — allowed ONLY from `approved` or `posted`; requires a `reason`;
 *              sets status `on_hold` + stores `reason_for_hold`.
 *   - resume — allowed ONLY from `on_hold`; sets status back to `posted` when the
 *              requisition has a public slug (it was live) else `approved`; clears
 *              `reason_for_hold`.
 *
 * Close / cancel are deliberately OUT of scope here (destructive, deferred).
 */
export const setRequisitionHoldInputSchema = z.object({
  requisitionId: z.string().uuid(),
  action: z.enum(["hold", "resume"]),
  /** Required (1..500) for `hold`; ignored/omitted for `resume`. */
  reason: z.string().min(1).max(500).optional(),
});
export type SetRequisitionHoldInput = z.infer<typeof setRequisitionHoldInputSchema>;

export const setRequisitionHoldOutputSchema = z.object({
  ok: z.literal(true),
  requisitionId: z.string().uuid(),
  /** The requisition's status AFTER the transition. */
  status: z.enum(["on_hold", "posted", "approved"]),
});
export type SetRequisitionHoldOutput = z.infer<typeof setRequisitionHoldOutputSchema>;

/**
 * The Iris `hold_requisition` action's OWN input contract — a subset of
 * setRequisitionHoldInputSchema (the action supplies `action: "hold"` itself).
 * `reason` is REQUIRED here (the drawer collects it), matching the server rule.
 */
export const holdRequisitionActionInputSchema = z.object({
  requisitionId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export type HoldRequisitionActionInput = z.infer<typeof holdRequisitionActionInputSchema>;

/**
 * The Iris `resume_requisition` action's OWN input contract — the requisition to
 * resume (the action supplies `action: "resume"` itself; no reason on resume).
 */
export const resumeRequisitionActionInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export type ResumeRequisitionActionInput = z.infer<typeof resumeRequisitionActionInputSchema>;

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

// ─────────────── irisHelp (IRIS-HELP) ───────────────

/**
 * irisHelp (IRIS-HELP) — the natural-language HELP/GUIDE layer. A question in; a
 * grounded answer out, drawn STRICTLY from the caller's role-eligible curated
 * capability entries. It ANSWERS, never executes: `suggestedActionId` (when
 * present) is one of the caller's role+policy eligible whitelisted actions and
 * only ever hands off into the UNCHANGED preview → confirm → execute pipeline.
 * Honours the iris_assistant kill-switch (degrades to a calm answer) and logs
 * cost under feature "iris_help".
 */
export const irisHelpInputSchema = z.object({
  /** The user's question. Bounded so a paste can't balloon the prompt. */
  question: z.string().min(1).max(1000),
  /** Optional page context so the answer can be situated ("on this page …"). */
  context: z
    .object({
      route: z.string().max(500).optional(),
      entityType: z.string().max(100).optional(),
      entityId: z.string().max(200).optional(),
    })
    .optional(),
});
export type IrisHelpInput = z.infer<typeof irisHelpInputSchema>;

export const irisHelpOutputSchema = z.object({
  /** The grounded answer (or the calm degrade text). Always present. */
  answer: z.string(),
  /**
   * A whitelisted action id the user could run now, or null. Guaranteed to be one
   * of the caller's role+policy eligible actions; the client opens its existing
   * form (a handoff), never dispatches from here.
   */
  suggestedActionId: z.string().nullable(),
  /** The suggested action's human label (for the handoff button), or null. */
  suggestedActionLabel: z.string().nullable(),
  /** The titles of the capability entries the answer drew from (for provenance). */
  citedTitles: z.array(z.string()),
});
export type IrisHelpOutput = z.infer<typeof irisHelpOutputSchema>;
