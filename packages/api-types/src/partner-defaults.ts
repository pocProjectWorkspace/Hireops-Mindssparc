import { z } from "zod";

/**
 * A3 — tenant partner defaults (tenants.settings.partnerDefaults).
 *
 * Persisted to `tenants.settings.partnerDefaults`, a SIBLING of slaThresholds /
 * governancePolicy / retentionPolicy / systemSetup — NO migration, NO new table.
 * It carries the ONE tenant-level partner knob that had been hard-coded: the
 * ownership-claim exclusivity window applied when a partner submits a candidate.
 *
 * PRECEDENCE, and the reason this block is only a fallback. An org with agreed
 * terms on file gets its live `partner_msa.exclusivity_window_days` — that
 * ALWAYS wins, because a signed commercial agreement outranks a tenant default.
 * This block is what an org with NO live MSA gets. In router terms:
 *   liveMsa?.exclusivityWindowDays ?? resolvePartnerDefaults(...).claimWindowDays
 *
 * An unconfigured (or corrupt) tenant resolves to defaultPartnerDefaults()
 * (`{ claimWindowDays: 90 }`) — byte-identical to the behaviour before this
 * block existed, when the api router carried a hard-coded
 * `PARTNER_CLAIM_WINDOW_DAYS = 90`. That constant is gone; the schema default
 * below is now the single source of the 90, and it is the same 90 the
 * `partner_msa.exclusivity_window_days` column defaults to, so an un-contracted
 * partner and a default MSA still behave identically.
 */

export const partnerDefaultsSchema = z.object({
  /**
   * Days a partner's ownership claim stays exclusive, for orgs with no live
   * MSA. 1..365: a zero-day window would expire the claim the instant it is
   * made (no exclusivity at all — express that by not empanelling, not by a
   * degenerate window), and a year is the practical ceiling for a staffing
   * exclusivity period.
   */
  claimWindowDays: z.number().int().min(1).max(365).default(90),
});
export type PartnerDefaults = z.infer<typeof partnerDefaultsSchema>;

/** The default block — an unconfigured tenant (the historical 90-day window). */
export function defaultPartnerDefaults(): PartnerDefaults {
  return partnerDefaultsSchema.parse({});
}

/**
 * Merge a raw stored `partnerDefaults` block (partial / unknown / absent) with
 * defaults. A malformed block fails safeParse and falls back to the default —
 * never throws (the resolveRetentionPolicy / resolveGovernancePolicy discipline).
 * This runs on the partner-submission hot path, so it must never be the thing
 * that fails a submission.
 */
export function resolvePartnerDefaults(raw: unknown): PartnerDefaults {
  const parsed = partnerDefaultsSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultPartnerDefaults();
}

// ─────────────────────────── get / update ───────────────────────────

export const getPartnerDefaultsInputSchema = z.object({});
export const getPartnerDefaultsOutputSchema = partnerDefaultsSchema;
export type GetPartnerDefaultsOutput = z.infer<typeof getPartnerDefaultsOutputSchema>;

export const updatePartnerDefaultsInputSchema = partnerDefaultsSchema;
export type UpdatePartnerDefaultsInput = z.infer<typeof updatePartnerDefaultsInputSchema>;
export const updatePartnerDefaultsOutputSchema = z.object({
  ok: z.literal(true),
  partnerDefaults: partnerDefaultsSchema,
});
export type UpdatePartnerDefaultsOutput = z.infer<typeof updatePartnerDefaultsOutputSchema>;
