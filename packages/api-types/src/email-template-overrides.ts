/**
 * Email/notification copy-override (G09) contracts. Pure zod — the tRPC surface
 * (`apps/api`) and the admin `/admin/email-templates` page both validate against
 * these single definitions.
 *
 * A tenant may override the SUBJECT and the NAMED TEXT SLOTS of each of the 12
 * transactional templates; layout, styles, and DATA bindings stay code-owned.
 * The slot/token catalog is the single source of truth in
 * `@hireops/email-templates` (EMAIL_TEMPLATE_CATALOG); these schemas describe
 * how that catalog + a tenant's overrides move over the wire. There is
 * deliberately NO raw-HTML field — only subject + slot strings.
 */

import { z } from "zod";

/**
 * The 12 transactional TemplateKeys (mirror of @hireops/notifications'
 * TemplateKey union). Kept as a zod enum here so the API can reject an unknown
 * template on input; the render + catalog remain the authority on which of
 * these are actually overridable.
 */
export const emailTemplateKeySchema = z.enum([
  "candidate.application_received",
  "candidate.stage_advanced",
  "candidate.offer_extended",
  "candidate.interview_invitation",
  "candidate.interview_cancelled",
  "candidate.account_activation",
  "candidate.agent_message",
  "recruiter.sla_breach_imminent",
  "recruiter.sla_ops_alert",
  "recruiter.offer_accepted",
  "recruiter.offer_declined",
]);
export type EmailTemplateKey = z.infer<typeof emailTemplateKeySchema>;

// Copy limits — generous enough for real subject/paragraph copy, bounded so a
// single override can't carry an unreasonable payload.
export const SUBJECT_OVERRIDE_MAX = 300;
export const SLOT_OVERRIDE_MAX = 2000;

// ─────────────────────────── catalog shapes ───────────────────────────

/** One overridable text run, as the editor renders it. */
export const emailTemplateSlotSchema = z.object({
  slotKey: z.string(),
  label: z.string(),
  defaultText: z.string(),
  tokens: z.array(z.string()),
});
export type EmailTemplateSlotDef = z.infer<typeof emailTemplateSlotSchema>;

/** Subject spec — null when the subject is composed at send time and is not
 * tenant-overridable (sla_ops_alert). */
export const emailTemplateSubjectSchema = z
  .object({
    defaultText: z.string(),
    tokens: z.array(z.string()),
    note: z.string().optional(),
  })
  .nullable();

/** A tenant's current override for one template (the effective, stored row).
 * `updatedAt` is null when no row exists yet. */
export const emailTemplateOverrideRowSchema = z.object({
  templateKey: emailTemplateKeySchema,
  subjectOverride: z.string().nullable(),
  slotOverrides: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  hasOverride: z.boolean(),
  updatedAt: z.string().nullable(), // ISO
});
export type EmailTemplateOverrideRow = z.infer<typeof emailTemplateOverrideRowSchema>;

/** One catalog entry + the tenant's current override (null when none). */
export const emailTemplateCatalogEntrySchema = z.object({
  templateKey: emailTemplateKeySchema,
  label: z.string(),
  description: z.string(),
  subject: emailTemplateSubjectSchema,
  slots: z.array(emailTemplateSlotSchema),
  override: emailTemplateOverrideRowSchema.nullable(),
});
export type EmailTemplateCatalogEntry = z.infer<typeof emailTemplateCatalogEntrySchema>;

// ─────────────────────────── getEmailTemplateCatalog ───────────────────────────

export const getEmailTemplateCatalogInputSchema = z.object({}).default({});
export const getEmailTemplateCatalogOutputSchema = z.object({
  templates: z.array(emailTemplateCatalogEntrySchema),
});
export type GetEmailTemplateCatalogOutput = z.infer<typeof getEmailTemplateCatalogOutputSchema>;

// ─────────────────────────── listEmailTemplateOverrides ───────────────────────────

export const listEmailTemplateOverridesInputSchema = z.object({}).default({});
export const listEmailTemplateOverridesOutputSchema = z.object({
  rows: z.array(emailTemplateOverrideRowSchema),
});
export type ListEmailTemplateOverridesOutput = z.infer<
  typeof listEmailTemplateOverridesOutputSchema
>;

// ─────────────────────────── upsertEmailTemplateOverride ───────────────────────────

/**
 * Admin upsert of one override row, keyed by (tenant, templateKey). The server
 * additionally validates that every slotKey is one the template's catalog
 * declares and that every referenced token belongs to that slot — unknown slots
 * or templates are rejected.
 */
export const upsertEmailTemplateOverrideInputSchema = z.object({
  templateKey: emailTemplateKeySchema,
  subjectOverride: z.string().trim().max(SUBJECT_OVERRIDE_MAX).nullable().default(null),
  slotOverrides: z.record(z.string(), z.string().max(SLOT_OVERRIDE_MAX)).default({}),
  enabled: z.boolean().default(true),
});
export type UpsertEmailTemplateOverrideInput = z.infer<
  typeof upsertEmailTemplateOverrideInputSchema
>;
export const upsertEmailTemplateOverrideOutputSchema = z.object({
  row: emailTemplateOverrideRowSchema,
});
export type UpsertEmailTemplateOverrideOutput = z.infer<
  typeof upsertEmailTemplateOverrideOutputSchema
>;

// ─────────────────────────── resetEmailTemplateOverride ───────────────────────────

/** Delete the tenant's override row for a template → back to shipped defaults. */
export const resetEmailTemplateOverrideInputSchema = z.object({
  templateKey: emailTemplateKeySchema,
});
export const resetEmailTemplateOverrideOutputSchema = z.object({
  templateKey: emailTemplateKeySchema,
  reset: z.boolean(),
});
export type ResetEmailTemplateOverrideOutput = z.infer<
  typeof resetEmailTemplateOverrideOutputSchema
>;

// ─────────────────────────── previewEmailTemplate ───────────────────────────

/**
 * Render a template through the REAL render path with representative sample data
 * + the DRAFT overrides (not yet saved), so the admin's live preview equals what
 * would send. Returns the resolved subject + HTML.
 */
export const previewEmailTemplateInputSchema = z.object({
  templateKey: emailTemplateKeySchema,
  subjectOverride: z.string().max(SUBJECT_OVERRIDE_MAX).optional(),
  slotOverrides: z.record(z.string(), z.string().max(SLOT_OVERRIDE_MAX)).optional(),
});
export type PreviewEmailTemplateInput = z.infer<typeof previewEmailTemplateInputSchema>;
export const previewEmailTemplateOutputSchema = z.object({
  subject: z.string(),
  html: z.string(),
});
export type PreviewEmailTemplateOutput = z.infer<typeof previewEmailTemplateOutputSchema>;
