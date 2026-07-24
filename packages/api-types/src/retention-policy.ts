import { z } from "zod";

/**
 * T4.3 — tenant document-retention policy (tenants.settings.retentionPolicy).
 *
 * Persisted to `tenants.settings.retentionPolicy` (a SIBLING of slaThresholds /
 * governancePolicy / systemSetup — NO migration, NO new table). It carries a
 * per-document-type-`code` retention override map PLUS a tenant-wide
 * `defaultYears` fallback, layered OVER the tenant-agnostic `document_types`
 * reference table's own `retention_years`.
 *
 * An unconfigured (or corrupt) tenant resolves to defaultRetentionPolicy()
 * (`{ overridesByCode: {}, defaultYears: null }`) — byte-identical to today: the
 * effective retention is simply the reference `retention_years`, and where THAT
 * is null a document is never overdue.
 *
 * HONESTY: this policy GENUINELY drives a real computation. `listDocumentsPastRetention`
 * uses `effectiveRetentionYears` to flag UPLOADED documents whose retention period
 * has elapsed — lowering a code's retention surfaces MORE overdue documents,
 * raising it removes them. What it deliberately does NOT do is delete or anonymise
 * anything: erasure is a MANUAL process (labelled as such in the UI), deferred to a
 * future dedicated ticket. This surface is an honest "documents past retention"
 * register, not an automation.
 */

/**
 * Years to retain a document of a given type. `0` = eligible for erasure
 * immediately after upload (a document uploaded any time in the past is already
 * past a 0-year retention); values run up to 100 years. `null` (only reachable
 * via `defaultYears` / the resolver, never a map value) = no retention configured,
 * so the document is NEVER overdue.
 */
const retentionYearsValue = z.number().int().min(0).max(100);

export const retentionPolicySchema = z.object({
  /** Per-document-type-`code` retention override, in whole years (0..100). */
  overridesByCode: z.record(z.string(), retentionYearsValue).default({}),
  /**
   * Tenant-wide fallback retention (years) for a document-type that has neither
   * a code override NOR a reference `retention_years`. `null` = no fallback →
   * such documents are never overdue.
   */
  defaultYears: z.number().int().min(0).max(100).nullable().default(null),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/** The default policy — an unconfigured tenant (no overrides, no fallback). */
export function defaultRetentionPolicy(): RetentionPolicy {
  return { overridesByCode: {}, defaultYears: null };
}

/**
 * Merge a raw stored `retentionPolicy` block (partial / unknown / absent) with
 * defaults. A malformed block fails safeParse and falls back to the default —
 * never throws (the resolveSlaThresholds / resolveGovernancePolicy discipline).
 */
export function resolveRetentionPolicy(raw: unknown): RetentionPolicy {
  const parsed = retentionPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultRetentionPolicy();
}

/**
 * The effective retention (years) for a document-type under a tenant's policy.
 * Precedence: a code override wins; else the reference `retention_years` from
 * `document_types`; else the tenant `defaultYears`; else `null`. `null` means
 * no retention is configured — such a document is NEVER overdue.
 *
 * Pure — the server uses this both to overlay `getDocumentRetention` and to
 * assemble the `listDocumentsPastRetention` overdue query, and the tests share
 * this one definition.
 */
export function effectiveRetentionYears(
  code: string,
  referenceYears: number | null,
  policy: RetentionPolicy,
): number | null {
  if (Object.prototype.hasOwnProperty.call(policy.overridesByCode, code)) {
    return policy.overridesByCode[code] ?? null;
  }
  if (referenceYears !== null && referenceYears !== undefined) {
    return referenceYears;
  }
  return policy.defaultYears;
}

// ─────────────────────────── get / update ───────────────────────────

export const getRetentionPolicyInputSchema = z.object({});
export const getRetentionPolicyOutputSchema = retentionPolicySchema;
export type GetRetentionPolicyOutput = z.infer<typeof getRetentionPolicyOutputSchema>;

export const updateRetentionPolicyInputSchema = retentionPolicySchema;
export type UpdateRetentionPolicyInput = z.infer<typeof updateRetentionPolicyInputSchema>;
export const updateRetentionPolicyOutputSchema = z.object({
  ok: z.literal(true),
  retentionPolicy: retentionPolicySchema,
});
export type UpdateRetentionPolicyOutput = z.infer<typeof updateRetentionPolicyOutputSchema>;

// ─────────────────────────── overdue register (listDocumentsPastRetention) ───────────────────────────

/** Which tenant-scoped document table an overdue row came from. */
export const overdueDocumentSourceSchema = z.enum(["application", "onboarding"]);
export type OverdueDocumentSource = z.infer<typeof overdueDocumentSourceSchema>;

/**
 * One document past its retention period under the tenant's policy. `ownerRef`
 * is a stable pointer to the owning record (an application id for `application`
 * rows, a case id for `onboarding` rows). `ageYears` is how long ago the
 * document was uploaded; it is >= `effectiveRetentionYears` for every row here.
 */
export const overdueDocumentRowSchema = z.object({
  id: z.string(),
  source: overdueDocumentSourceSchema,
  documentTypeCode: z.string(),
  documentTypeName: z.string(),
  uploadedAt: z.string(),
  ageYears: z.number(),
  effectiveRetentionYears: z.number().int(),
  ownerRef: z.string(),
});
export type OverdueDocumentRow = z.infer<typeof overdueDocumentRowSchema>;

export const listDocumentsPastRetentionInputSchema = z.object({});
export const listDocumentsPastRetentionOutputSchema = z.object({
  items: z.array(overdueDocumentRowSchema),
});
export type ListDocumentsPastRetentionOutput = z.infer<
  typeof listDocumentsPastRetentionOutputSchema
>;
