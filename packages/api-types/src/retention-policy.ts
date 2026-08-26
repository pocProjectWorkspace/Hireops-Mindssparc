import { z } from "zod";

/**
 * T4.3 / A2 — tenant retention policy (tenants.settings.retentionPolicy).
 *
 * Persisted to `tenants.settings.retentionPolicy` (a SIBLING of slaThresholds /
 * governancePolicy / systemSetup — NO migration, NO new table). It now carries
 * TWO INDEPENDENT HALVES with genuinely different consequences, and the
 * difference matters enough to state up front:
 *
 *   1. UPLOADED DOCUMENTS (T4.3) — a per-document-type-`code` retention override
 *      map plus a tenant-wide `defaultYears` fallback, layered OVER the
 *      tenant-agnostic `document_types` reference table's own `retention_years`.
 *      This half is a REGISTER, NOT AN AUTOMATION. It genuinely drives a real
 *      computation — `listDocumentsPastRetention` uses `effectiveRetentionYears`
 *      to flag uploaded documents whose retention period has elapsed, so
 *      lowering a code's retention surfaces MORE overdue documents and raising
 *      it removes them — but it deliberately does NOT delete or anonymise
 *      anything. Erasure is a MANUAL process (labelled as such in the UI),
 *      deferred to a future dedicated ticket.
 *
 *   2. INTERVIEW AUDIO (A2) — `interviewAudioDays`. This half IS AN AUTOMATION.
 *      The daily worker sweep (`interview-media-purge.ts`) reads it per tenant
 *      and REALLY DELETES THE BYTES: the stored object goes, `storage_key` is
 *      nulled and `media_purged_at` is stamped. Lowering this number does not
 *      surface a row on a register, it schedules previously-kept audio for
 *      deletion on the next sweep, and there is no undo. Transcripts and notes
 *      are untouched by that sweep — they are kept indefinitely.
 *
 * An unconfigured (or corrupt) tenant resolves to defaultRetentionPolicy()
 * (`{ overridesByCode: {}, defaultYears: null, interviewAudioDays: 30 }`) —
 * byte-identical to before either half existed: the effective document retention
 * is simply the reference `retention_years` (and where THAT is null a document
 * is never overdue), and audio purges at the 30 days that used to be the worker
 * constant `INTERVIEW_MEDIA_RETENTION_DAYS`.
 *
 * A NOTE ON THE CEILING. `interviewAudioDays` is bounded ABOVE by
 * INTERVIEW_AUDIO_HARD_CEILING_DAYS (90). That ceiling is NOT configurable and
 * is not meant to be: the purge sweep applies it to the recording's own
 * `created_at` regardless of what the interview ever did, so that rounds which
 * never reach a terminal state (no-shows especially) cannot keep audio forever.
 * A tenant sets its number UNDER the platform promise; it can never raise the
 * promise.
 */

/**
 * Years to retain a document of a given type. `0` = eligible for erasure
 * immediately after upload (a document uploaded any time in the past is already
 * past a 0-year retention); values run up to 100 years. `null` (only reachable
 * via `defaultYears` / the resolver, never a map value) = no retention configured,
 * so the document is NEVER overdue.
 */
const retentionYearsValue = z.number().int().min(0).max(100);

/**
 * A2 — the default interview-audio retention, in days from interview
 * completion. THE single source of the 30 that used to live in the worker as
 * `INTERVIEW_MEDIA_RETENTION_DAYS` (that constant is now an alias of this one).
 * A tenant with no `retentionPolicy` block, or with a malformed one, purges
 * audio at exactly this number — byte-identical to the pre-A2 sweep.
 */
export const INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT = 30;

/**
 * A2 / sweep B9 — the platform's audio hard ceiling, in days from the
 * RECORDING's own `created_at`. NOT tenant-configurable, deliberately: it is
 * the backstop that catches rounds which never reach a terminal state (a
 * no-show stamps neither `completed_at` nor `cancelled_at`, so the retention
 * window can never fire for it). Without it, "audio is deleted" would be false
 * for exactly the rounds nobody is watching.
 *
 * It is also the UPPER BOUND on `interviewAudioDays` below: a tenant may keep
 * audio for LESS time than the platform promises, never more.
 */
export const INTERVIEW_AUDIO_HARD_CEILING_DAYS = 90;

export const retentionPolicySchema = z.object({
  /** Per-document-type-`code` retention override, in whole years (0..100). */
  overridesByCode: z.record(z.string(), retentionYearsValue).default({}),
  /**
   * Tenant-wide fallback retention (years) for a document-type that has neither
   * a code override NOR a reference `retention_years`. `null` = no fallback →
   * such documents are never overdue.
   */
  defaultYears: z.number().int().min(0).max(100).nullable().default(null),
  /**
   * A2 — how long interview AUDIO is kept, in days from interview completion
   * (`GREATEST(completed_at, cancelled_at)`). Read per tenant by the daily
   * `interview_media_purge` sweep, which really deletes the bytes.
   *
   * MINIMUM 1, NOT 0, on purpose. A 0 would mean "purge everything the sweep
   * can see, tonight" — a value a typo can produce and nothing can undo. If a
   * tenant genuinely wants same-day deletion that is a decision worth making
   * explicitly, not one worth being one keystroke away from.
   *
   * MAXIMUM INTERVIEW_AUDIO_HARD_CEILING_DAYS (90), because the sweep's ceiling
   * leg would delete the audio at 90 days anyway; allowing a bigger number here
   * would let the surface promise a retention the platform does not keep.
   *
   * NOT a document-retention field: it is measured in days, not years, and
   * transcripts and interview notes are unaffected by it — they are kept
   * indefinitely.
   */
  interviewAudioDays: z
    .number()
    .int()
    .min(1)
    .max(INTERVIEW_AUDIO_HARD_CEILING_DAYS)
    .default(INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/**
 * The default policy — an unconfigured tenant (no document overrides, no
 * document fallback, the platform-default audio retention).
 *
 * Built by parsing `{}` rather than by re-listing the values, so a field added
 * to the schema can never be forgotten here (the pre-A2 hand-written literal
 * was exactly the shape that goes stale).
 */
export function defaultRetentionPolicy(): RetentionPolicy {
  return retentionPolicySchema.parse({});
}

/**
 * Merge a raw stored `retentionPolicy` block (partial / unknown / absent) with
 * defaults. A malformed block fails safeParse and falls back to the default —
 * never throws (the resolveSlaThresholds / resolveGovernancePolicy discipline).
 *
 * ALL-OR-NOTHING, and worth knowing before you rely on it: safeParse is applied
 * to the WHOLE block, so ONE bad field discards the others. A block whose
 * `interviewAudioDays` is out of range loses that tenant's document overrides
 * too, and vice versa. That is the safe direction — every field falls back to a
 * platform default rather than to a half-read policy — but it does mean a
 * hand-edited settings row can quietly widen document retention. The only
 * writer is `updateRetentionPolicy`, which validates against this same schema,
 * so a block can only get into that state by direct DB edit.
 *
 * PARTIAL BLOCKS ARE FINE, though, and that is deliberate: this schema is not
 * `.strict()` and every field has a default, so a stored PRE-A2 block (document
 * fields only) still parses and simply gains
 * `interviewAudioDays: INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT`. No migration,
 * no backfill — pinned by the retention-policy test.
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
