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

/** Platform default notice before a claim lapses (BUG-9). */
export const PLATFORM_CLAIM_EXPIRY_WARNING_DAYS = 14;
/** Upper bound for the notice — also the worker's widest scan horizon. */
export const CLAIM_EXPIRY_WARNING_DAYS_MAX = 90;

export const partnerDefaultsSchema = z.object({
  /**
   * Days a partner's ownership claim stays exclusive, for orgs with no live
   * MSA. 1..365: a zero-day window would expire the claim the instant it is
   * made (no exclusivity at all — express that by not empanelling, not by a
   * degenerate window), and a year is the practical ceiling for a staffing
   * exclusivity period.
   */
  claimWindowDays: z.number().int().min(1).max(365).default(90),
  /**
   * C1-BUGS BUG-9 — how many days before an ownership claim expires the
   * partner is warned. ONE number used by both the partner-portal attention
   * feed (apps/api lib/partner-team.ts) and the worker's warning email
   * (apps/workers jobs/ownership-claim-sweep.ts) — they had drifted to 14 and
   * 7. Applies to every claim in the tenant, MSA or not (an MSA sets the
   * window's length, not the notice). 1..90.
   */
  claimExpiryWarningDays: z
    .number()
    .int()
    .min(1)
    .max(CLAIM_EXPIRY_WARNING_DAYS_MAX)
    .default(PLATFORM_CLAIM_EXPIRY_WARNING_DAYS),
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
  if (parsed.success) return parsed.data;
  // Field-wise fallback: one malformed knob must not reset the other.
  const base = defaultPartnerDefaults();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const win = partnerDefaultsSchema.shape.claimWindowDays.safeParse(r.claimWindowDays);
  const warn = partnerDefaultsSchema.shape.claimExpiryWarningDays.safeParse(
    r.claimExpiryWarningDays,
  );
  return {
    claimWindowDays: win.success ? win.data : base.claimWindowDays,
    claimExpiryWarningDays: warn.success ? warn.data : base.claimExpiryWarningDays,
  };
}

/** The claim-expiry warning lead time for a WHOLE tenants.settings jsonb. Never throws. */
export function resolveClaimExpiryWarningDays(tenantSettings: unknown): number {
  const block =
    tenantSettings && typeof tenantSettings === "object"
      ? (tenantSettings as Record<string, unknown>).partnerDefaults
      : undefined;
  return resolvePartnerDefaults(block).claimExpiryWarningDays;
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

// ─────────────────────────── partner claim terms (BUG-8) ───────────────────────────

/**
 * C1-BUGS BUG-8 — the ownership terms a partner org is submitting under, so
 * the submit form's attestation states the REAL window and scope instead of a
 * hard-coded "MSA §4.2 … 90-day". `source` = which layer the window came from
 * (the org's live MSA, else the tenant's partner default).
 */
export const partnerClaimTermsSchema = z.object({
  claimWindowDays: z.number().int().min(1).max(3650),
  exclusivityScope: z.enum(["org_wide", "req_only"]),
  source: z.enum(["msa", "tenant_default"]),
});
export type PartnerClaimTerms = z.infer<typeof partnerClaimTermsSchema>;

export const partnerGetClaimTermsInputSchema = z.object({}).default({});
export const partnerGetClaimTermsOutputSchema = partnerClaimTermsSchema;
export type PartnerGetClaimTermsOutput = z.infer<typeof partnerGetClaimTermsOutputSchema>;

/**
 * Versioned partner ownership attestation. Bump on ANY wording change — the
 * version is stored with every submission (candidate consent metadata).
 *   v1 (2026-05): "per {tenant}'s MSA Section 4.2. The 90-day exclusivity
 *                  window starts now…" — fixed clause + fixed 90 days.
 *   v2 (2026-11): window + scope from the org's terms; no clause reference.
 */
export const PARTNER_CONSENT_VERSION = "partner-msa-v2-2026-11";

/** The ownership attestation sentence for the submit form. Pure. */
export function partnerOwnershipAttestation(
  terms: Pick<PartnerClaimTerms, "claimWindowDays" | "exclusivityScope" | "source">,
  tenantName: string,
): string {
  const basis =
    terms.source === "msa"
      ? `under my organisation's agreement with ${tenantName}`
      : `under ${tenantName}'s partner terms`;
  const scope =
    terms.exclusivityScope === "req_only"
      ? "for this requisition only"
      : `across all ${tenantName} requisitions`;
  const days = terms.claimWindowDays === 1 ? "1-day" : `${terms.claimWindowDays}-day`;
  return `By submitting, I claim ownership of this candidate ${basis}. The ${days} exclusivity window (${scope}) starts now if this submission is accepted.`;
}
