/**
 * Panel-pool library (T3.3 / G16) contracts. Pure zod — the tRPC surface
 * (`apps/api`), the admin `/admin/panel-pools` page, and the owner plan-setup
 * pool picker all validate against these single definitions.
 *
 * A tenant's panel-pool library is a FLAT, named set of interview-panel pools
 * (with an optional free-text `focus` label), each carrying a roster of
 * memberships. It GENUINELY drives an interview-plan round: when a round sends a
 * panelPoolId with no manual override, upsertInterviewPlan COPIES the pool's
 * member membership-ids onto the round's default_panel_membership_ids — the same
 * advisory uuid[] INT-02 reads to seed interview_panelists. The round retains
 * panel_pool_id as provenance, so an override (explicit member ids) is visible
 * as a divergence from the linked pool.
 *
 * Archiving retires a pool from the picker without breaking rounds already
 * attached to it (the interview_plans FK is ON DELETE RESTRICT).
 */

import { z } from "zod";

/** One panel-pool row as the admin surface + the plan-setup picker render it. */
export const panelPoolRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  focus: z.string().nullable(),
  isArchived: z.boolean(),
  /** The pool's roster — membership ids (tenant_user_memberships.id). */
  memberMembershipIds: z.array(z.string().uuid()),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});
export type PanelPoolRow = z.infer<typeof panelPoolRowSchema>;

// ─────────────────────────── listPanelPools ───────────────────────────

export const listPanelPoolsInputSchema = z
  .object({
    /** Include archived pools too (the admin surface shows them; the plan-setup
     * picker does not). Defaults to active-only. */
    includeArchived: z.boolean().optional(),
  })
  .default({});
export type ListPanelPoolsInput = z.infer<typeof listPanelPoolsInputSchema>;

export const listPanelPoolsOutputSchema = z.object({
  rows: z.array(panelPoolRowSchema),
});
export type ListPanelPoolsOutput = z.infer<typeof listPanelPoolsOutputSchema>;

// ─────────────────────────── createPanelPool ───────────────────────────

export const createPanelPoolInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Optional free-text focus label (e.g. "Backend", "Leadership loop"). */
  focus: z.string().trim().max(200).optional(),
});
export type CreatePanelPoolInput = z.infer<typeof createPanelPoolInputSchema>;

export const createPanelPoolOutputSchema = z.object({
  row: panelPoolRowSchema,
});
export type CreatePanelPoolOutput = z.infer<typeof createPanelPoolOutputSchema>;

// ─────────────────────────── renamePanelPool ───────────────────────────

export const renamePanelPoolInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  focus: z.string().trim().max(200).nullable().optional(),
});
export type RenamePanelPoolInput = z.infer<typeof renamePanelPoolInputSchema>;

export const renamePanelPoolOutputSchema = z.object({
  row: panelPoolRowSchema,
});
export type RenamePanelPoolOutput = z.infer<typeof renamePanelPoolOutputSchema>;

// ─────────────────────────── setPanelPoolMembers ───────────────────────────

export const setPanelPoolMembersInputSchema = z.object({
  id: z.string().uuid(),
  /** Replace-set the pool's roster. Deduped + validated server-side (every id
   * must be an active membership in this tenant). */
  membershipIds: z.array(z.string().uuid()).max(50),
});
export type SetPanelPoolMembersInput = z.infer<typeof setPanelPoolMembersInputSchema>;

export const setPanelPoolMembersOutputSchema = z.object({
  row: panelPoolRowSchema,
});
export type SetPanelPoolMembersOutput = z.infer<typeof setPanelPoolMembersOutputSchema>;

// ─────────────────────────── setPanelPoolArchived ───────────────────────────

export const setPanelPoolArchivedInputSchema = z.object({
  id: z.string().uuid(),
  archived: z.boolean(),
});
export type SetPanelPoolArchivedInput = z.infer<typeof setPanelPoolArchivedInputSchema>;

export const setPanelPoolArchivedOutputSchema = z.object({
  row: panelPoolRowSchema,
});
export type SetPanelPoolArchivedOutput = z.infer<typeof setPanelPoolArchivedOutputSchema>;
