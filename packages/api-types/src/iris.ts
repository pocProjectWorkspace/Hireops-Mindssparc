import { z } from "zod";

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
 * the minimal `{id,label,group,destructive,bulk}` the menu path requires.
 */
export const irisActionMenuItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  group: z.string(),
  destructive: z.boolean(),
  bulk: z.boolean(),
});
export type IrisActionMenuItem = z.infer<typeof irisActionMenuItemSchema>;

export const irisListActionsInputSchema = z.object({}).optional();
export const irisListActionsOutputSchema = z.object({
  actions: z.array(irisActionMenuItemSchema),
});
export type IrisListActionsOutput = z.infer<typeof irisListActionsOutputSchema>;

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

export const irisPreviewOutputSchema = z.object({
  summary: z.string(),
  details: z.array(z.string()),
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
  entityId: z.string().uuid().nullable(),
  resultSummary: z.string(),
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
