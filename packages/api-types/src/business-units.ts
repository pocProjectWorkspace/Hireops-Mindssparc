/**
 * Business-unit management (T3.1 / G14) contracts. Pure zod — the tRPC surface
 * (`apps/api`), the admin `/admin/business-units` page, and the requisition
 * wizard's business-unit picker all validate against these single definitions.
 *
 * The managed list is the org's REAL intra-tenant org structure: a hierarchy of
 * units (self-referential via `parentBusinessUnitId`), tenant-scoped. It
 * GENUINELY drives requisition creation — the wizard's human creator picks a
 * unit id from this controlled, non-archived list rather than typing free text.
 *
 * Slugs are immutable: positions FK a unit by id, so a rename updates only the
 * display `name` and flows through the live department-name join. Archiving
 * retires a unit from the picker without breaking positions already on it.
 */

import { z } from "zod";

/** One business-unit row as the admin surface + the wizard picker render it.
 * Flat — the UI builds the tree from `parentBusinessUnitId`. */
export const businessUnitRowSchema = z.object({
  id: z.string().uuid(),
  parentBusinessUnitId: z.string().uuid().nullable(),
  name: z.string().min(1).max(120),
  slug: z.string(),
  isArchived: z.boolean(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});
export type BusinessUnitRow = z.infer<typeof businessUnitRowSchema>;

// ─────────────────────────── listBusinessUnits ───────────────────────────

export const listBusinessUnitsInputSchema = z
  .object({
    /** Include archived units too (the admin surface shows them; the wizard
     * picker does not). Defaults to active-only. */
    includeArchived: z.boolean().optional(),
  })
  .default({});
export type ListBusinessUnitsInput = z.infer<typeof listBusinessUnitsInputSchema>;

export const listBusinessUnitsOutputSchema = z.object({
  rows: z.array(businessUnitRowSchema),
});
export type ListBusinessUnitsOutput = z.infer<typeof listBusinessUnitsOutputSchema>;

// ─────────────────────────── createBusinessUnit ───────────────────────────

export const createBusinessUnitInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Optional parent — null / omitted = a top-level unit. */
  parentBusinessUnitId: z.string().uuid().nullable().optional(),
});
export type CreateBusinessUnitInput = z.infer<typeof createBusinessUnitInputSchema>;

export const createBusinessUnitOutputSchema = z.object({
  row: businessUnitRowSchema,
});
export type CreateBusinessUnitOutput = z.infer<typeof createBusinessUnitOutputSchema>;

// ─────────────────────────── renameBusinessUnit ───────────────────────────

/** Rename updates `name` only — slug stays immutable so positions keep their FK
 * and the rename reflects everywhere via the live join. */
export const renameBusinessUnitInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
});
export type RenameBusinessUnitInput = z.infer<typeof renameBusinessUnitInputSchema>;

export const renameBusinessUnitOutputSchema = z.object({
  row: businessUnitRowSchema,
});
export type RenameBusinessUnitOutput = z.infer<typeof renameBusinessUnitOutputSchema>;

// ─────────────────────────── reparentBusinessUnit ───────────────────────────

export const reparentBusinessUnitInputSchema = z.object({
  id: z.string().uuid(),
  /** New parent, or null to move the unit to the top level. Rejected if it
   * would form a cycle (self-parent or a descendant of the unit). */
  parentBusinessUnitId: z.string().uuid().nullable(),
});
export type ReparentBusinessUnitInput = z.infer<typeof reparentBusinessUnitInputSchema>;

export const reparentBusinessUnitOutputSchema = z.object({
  row: businessUnitRowSchema,
});
export type ReparentBusinessUnitOutput = z.infer<typeof reparentBusinessUnitOutputSchema>;

// ─────────────────────────── setBusinessUnitArchived ───────────────────────────

export const setBusinessUnitArchivedInputSchema = z.object({
  id: z.string().uuid(),
  archived: z.boolean(),
});
export type SetBusinessUnitArchivedInput = z.infer<typeof setBusinessUnitArchivedInputSchema>;

export const setBusinessUnitArchivedOutputSchema = z.object({
  row: businessUnitRowSchema,
});
export type SetBusinessUnitArchivedOutput = z.infer<typeof setBusinessUnitArchivedOutputSchema>;
