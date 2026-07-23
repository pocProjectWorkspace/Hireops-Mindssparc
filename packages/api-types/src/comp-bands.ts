/**
 * Comp-band library (T3.2 / G15) contracts. Pure zod — the tRPC surface
 * (`apps/api`), the admin `/admin/comp-bands` page, and the requisition wizard's
 * comp-band picker all validate against these single definitions.
 *
 * A tenant's comp-band library is a FLAT, named set of compensation bands (with
 * an optional free-text `level` label). It GENUINELY drives requisition
 * creation: when the wizard sends a `compBandId`, the server COPIES the band's
 * min/max/currency onto the position's comp columns, which the deterministic
 * comp-rules verdict engine + feasibility/detail views already read. The
 * position retains `comp_band_id` as provenance, so an edit to the filled values
 * is visible as a value divergence from the linked band.
 *
 * minMajor / maxMajor are MAJOR-unit currency (INR rupees), matching
 * positions.comp_band_min/max. Archiving retires a band from the picker without
 * breaking positions already attached to it (the FK is ON DELETE RESTRICT).
 */

import { z } from "zod";

/** One comp-band row as the admin surface + the wizard picker render it. */
export const compBandRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  level: z.string().nullable(),
  currency: z.string().length(3),
  minMajor: z.number(),
  maxMajor: z.number(),
  isArchived: z.boolean(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});
export type CompBandRow = z.infer<typeof compBandRowSchema>;

// ─────────────────────────── listCompBands ───────────────────────────

export const listCompBandsInputSchema = z
  .object({
    /** Include archived bands too (the admin surface shows them; the wizard
     * picker does not). Defaults to active-only. */
    includeArchived: z.boolean().optional(),
  })
  .default({});
export type ListCompBandsInput = z.infer<typeof listCompBandsInputSchema>;

export const listCompBandsOutputSchema = z.object({
  rows: z.array(compBandRowSchema),
});
export type ListCompBandsOutput = z.infer<typeof listCompBandsOutputSchema>;

// ─────────────────────────── createCompBand ───────────────────────────

export const createCompBandInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Optional free-text level label (e.g. "Senior", "P4"). */
    level: z.string().trim().max(80).optional(),
    currency: z.string().length(3).default("INR"),
    minMajor: z.number().min(0),
    maxMajor: z.number().min(0),
  })
  .refine((v) => v.minMajor <= v.maxMajor, {
    message: "minMajor must be less than or equal to maxMajor",
    path: ["minMajor"],
  });
export type CreateCompBandInput = z.infer<typeof createCompBandInputSchema>;

export const createCompBandOutputSchema = z.object({
  row: compBandRowSchema,
});
export type CreateCompBandOutput = z.infer<typeof createCompBandOutputSchema>;

// ─────────────────────────── updateCompBand ───────────────────────────

export const updateCompBandInputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    level: z.string().trim().max(80).optional(),
    currency: z.string().length(3),
    minMajor: z.number().min(0),
    maxMajor: z.number().min(0),
  })
  .refine((v) => v.minMajor <= v.maxMajor, {
    message: "minMajor must be less than or equal to maxMajor",
    path: ["minMajor"],
  });
export type UpdateCompBandInput = z.infer<typeof updateCompBandInputSchema>;

export const updateCompBandOutputSchema = z.object({
  row: compBandRowSchema,
});
export type UpdateCompBandOutput = z.infer<typeof updateCompBandOutputSchema>;

// ─────────────────────────── setCompBandArchived ───────────────────────────

export const setCompBandArchivedInputSchema = z.object({
  id: z.string().uuid(),
  archived: z.boolean(),
});
export type SetCompBandArchivedInput = z.infer<typeof setCompBandArchivedInputSchema>;

export const setCompBandArchivedOutputSchema = z.object({
  row: compBandRowSchema,
});
export type SetCompBandArchivedOutput = z.infer<typeof setCompBandArchivedOutputSchema>;
