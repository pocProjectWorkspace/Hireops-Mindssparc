/**
 * Sourcing-channel registry (G04) contracts. Pure zod — the tRPC surface
 * (`apps/api`), the admin `/admin/sources` page, and the recruiter surfaces
 * that consume the labels all validate against these single definitions.
 *
 * The registry is a tenant's editable CONFIG over the fixed `application_source`
 * enum: which channels are enabled, what the org calls them, and an honesty
 * flag (`ingestionMode`) separating a CONFIGURED channel from a live auto-pull
 * (which is a deferred connector work package — see the schema header).
 */

import { z } from "zod";
import { applicationSourceSchema } from "./enums";

/**
 * manual            — candidates enter via existing portal/manual flows.
 * connector_pending — an automated pull is a deferred connector work package;
 *                     the channel is configured, not live. The UI labels it so.
 */
export const ingestionModeSchema = z.enum(["manual", "connector_pending"]);
export type IngestionMode = z.infer<typeof ingestionModeSchema>;

/** The `config` blob — a small, additive placeholder bag. No connector reads
 * it yet; it just persists the operator's per-channel settings (career-site
 * slug, mailbox address string, job-board name, …). Kept permissive on purpose. */
export const tenantSourceConfigSchema = z.record(z.string(), z.string()).default({});
export type TenantSourceConfig = z.infer<typeof tenantSourceConfigSchema>;

/** One registry row as the admin surface + recruiter surfaces render it. */
export const tenantSourceRowSchema = z.object({
  id: z.string().uuid(),
  sourceEnum: applicationSourceSchema,
  label: z.string().min(1).max(80),
  enabled: z.boolean(),
  ingestionMode: ingestionModeSchema,
  config: z.record(z.string(), z.string()),
  notes: z.string().max(500).nullable(),
  updatedAt: z.string(), // ISO
});
export type TenantSourceRow = z.infer<typeof tenantSourceRowSchema>;

// ─────────────────────────── listTenantSources ───────────────────────────

export const listTenantSourcesInputSchema = z.object({}).default({});
export const listTenantSourcesOutputSchema = z.object({
  rows: z.array(tenantSourceRowSchema),
});
export type ListTenantSourcesOutput = z.infer<typeof listTenantSourcesOutputSchema>;

// ─────────────────────────── upsertTenantSource ───────────────────────────

/**
 * Admin upsert of one registry row, keyed by (tenant, sourceEnum). The label
 * carries a sensible min length; ingestionMode + config + notes default so an
 * admin who just adds a channel still records honest, consistent state.
 */
export const upsertTenantSourceInputSchema = z.object({
  sourceEnum: applicationSourceSchema,
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  ingestionMode: ingestionModeSchema.default("manual"),
  config: tenantSourceConfigSchema,
  notes: z.string().trim().max(500).nullable().default(null),
});
export type UpsertTenantSourceInput = z.infer<typeof upsertTenantSourceInputSchema>;
export const upsertTenantSourceOutputSchema = z.object({
  row: tenantSourceRowSchema,
});
export type UpsertTenantSourceOutput = z.infer<typeof upsertTenantSourceOutputSchema>;

// ─────────────────────────── setTenantSourceEnabled ───────────────────────────

export const setTenantSourceEnabledInputSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
});
export const setTenantSourceEnabledOutputSchema = z.object({
  row: tenantSourceRowSchema,
});
export type SetTenantSourceEnabledOutput = z.infer<typeof setTenantSourceEnabledOutputSchema>;
