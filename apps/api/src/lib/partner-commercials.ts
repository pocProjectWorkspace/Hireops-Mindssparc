/**
 * P2.2 — partner commercials: the MSA behind a partner org, and the fee each
 * partner-sourced hire accrues under it.
 *
 * Shape follows apps/api/src/lib/partner-admin.ts exactly — every export is a
 * function over a caller-supplied tenant-bound db handle plus an explicit
 * tenantId, so the router procedures stay thin and this file is directly
 * testable — with the same two load-bearing disciplines: an EXPLICIT tenant_id
 * predicate on every statement (the partner tables carry only a tenant-level
 * RLS policy, so org scoping must be a predicate, never an assumption), and
 * the NOT_FOUND posture for a cross-tenant org id.
 *
 * Two rules from the schema headers govern everything here:
 *
 *   1. Terms are NEVER updated in place. `partner_msa` has one live row per org
 *      (partial unique WHERE effective_to IS NULL); changing terms closes the
 *      old row and inserts a new one. That is what lets a fee accrued in March
 *      keep pointing at the terms it was actually computed from.
 *   2. A fee freezes its terms anyway. `msa_snapshot` copies the MSA's
 *      commercial fields at accrual time, so even a deleted or superseded MSA
 *      can't rewrite history — belt and braces, because this is money.
 *
 * The accrual itself (accruePartnerFeeOnHire) is the odd one out: it runs from
 * runOfferAcceptSideEffects on a raw postgres.js client, not a drizzle tx, and
 * it is BEST-EFFORT by construction. An acceptance is already committed and
 * durable by the time it runs; nothing in here may unwind one, so every failure
 * path logs and returns.
 *
 * Reality #113 applies to that one function, as it does to onboarding-case.ts:
 * raw sql fragments can't serialize JS Dates, so every timestamp it writes is a
 * `.toISOString()` string with an explicit `::timestamptz` cast, and every
 * timestamp it reads is coerced back through `new Date()` rather than trusted.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  sql as poolSql,
  applications,
  candidates,
  partnerFees,
  partnerMsa,
  partnerOrgs,
  persons,
  positions,
  requisitions,
  type TenantBoundDb,
  type PartnerMsa,
} from "@hireops/db";
import type { Logger } from "@hireops/observability";
import type {
  GetPartnerOrgCommercialsOutput,
  PartnerFeeRollups,
  PartnerFeeRow,
  PartnerGetCommercialsOutput,
  PartnerMsaRow,
  PartnerMsaTermsInput,
  PartnerOrgFeeRow,
  UpsertPartnerMsaOutput,
} from "@hireops/api-types";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/**
 * The commercial fields frozen into partner_fees.msa_snapshot. camelCase to
 * match the wire names the surfaces read them back under — the ids and
 * timestamps are deliberately absent: msa_id is already its own column, and a
 * copy of created_at would only invite someone to trust it as the fee's date.
 */
export interface PartnerMsaSnapshot {
  feeModel: string;
  feePercent: number | null;
  flatFeeMinor: number | null;
  feeCurrency: string;
  exclusivityWindowDays: number;
  exclusivityScope: string;
  probationHoldbackPercent: number;
  replacementGuaranteeDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Postgres unique-violation detector (SQLSTATE 23505), driver-tolerant. Reads
 * the CODE, not the message, for the reason ownership-claim-sweep spells out:
 * drizzle wraps the driver error, so a message-substring test silently never
 * matches. The driver error survives as `cause`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/** numeric/int8 columns arrive as strings from the driver; null stays null. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A drizzle partner_msa row → the wire shape. */
function toMsaRow(row: PartnerMsa): PartnerMsaRow {
  return {
    msaId: row.id,
    feeModel: row.feeModel as PartnerMsaRow["feeModel"],
    feePercent: toNumberOrNull(row.feePercent),
    flatFeeMinor: row.flatFeeMinor === null ? null : Number(row.flatFeeMinor),
    feeCurrency: row.feeCurrency,
    exclusivityWindowDays: row.exclusivityWindowDays,
    exclusivityScope: row.exclusivityScope as PartnerMsaRow["exclusivityScope"],
    probationHoldbackPercent: toNumberOrNull(row.probationHoldbackPercent) ?? 0,
    replacementGuaranteeDays: row.replacementGuaranteeDays,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
  };
}

/** NOT_FOUND when the org isn't this tenant's — the cross-tenant probe answer. */
async function assertOrgInTenant(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<void> {
  const [org] = await db
    .select({ id: partnerOrgs.id })
    .from(partnerOrgs)
    .where(and(eq(partnerOrgs.tenantId, tenantId), eq(partnerOrgs.id, partnerOrgId)))
    .limit(1);
  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_org_not_found" });
  }
}

// ───────────────────────────── MSA reads ─────────────────────────────

/**
 * The org's LIVE terms, or null when none have been agreed. `effective_to IS
 * NULL` is the liveness test the partial unique index enforces, so this can
 * never return two rows.
 *
 * Called from two very different places: the commercials surfaces, and
 * partnerSubmitCandidate — which reads exclusivity_window_days from it to size
 * the ownership claim it is about to write.
 */
export async function getLivePartnerMsa(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<PartnerMsa | null> {
  const [row] = await db
    .select()
    .from(partnerMsa)
    .where(
      and(
        eq(partnerMsa.tenantId, tenantId),
        eq(partnerMsa.partnerOrgId, partnerOrgId),
        isNull(partnerMsa.effectiveTo),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ──────────────────────────── MSA writes ────────────────────────────

export interface UpsertPartnerMsaArgs {
  tenantId: string;
  partnerOrgId: string;
  /** tenant_user_memberships.id of the staff member agreeing the terms. */
  actorMembershipId: string | null;
  input: PartnerMsaTermsInput;
}

/**
 * Agree terms, or change them: CLOSE-AND-REOPEN, in this order — verify the org
 * is ours, stamp effective_to on the live row if there is one, insert the new
 * row. Never an UPDATE of the terms themselves.
 *
 * Order matters for the partial unique index (uniq_partner_msa_live): the old
 * row has to stop being live before the new one starts, and both statements run
 * inside the procedure's tenant-bound tx, so a failure anywhere leaves the
 * original terms untouched rather than an org with no live MSA.
 *
 * The operand pairing (percentage → feePercent, flat → flatFeeMinor) is already
 * a zod refinement on the input, mirroring partner_msa_fee_operand_check. What
 * happens HERE is the other half: the operand the chosen model does NOT use is
 * written as NULL rather than passed through, so a form that kept a stale value
 * in a hidden field can't persist a contradiction the CHECK happens to allow.
 */
export async function upsertPartnerMsa(
  db: TenantBoundDb,
  args: UpsertPartnerMsaArgs,
): Promise<UpsertPartnerMsaOutput> {
  const { tenantId, partnerOrgId, input } = args;
  await assertOrgInTenant(db, tenantId, partnerOrgId);

  const [closed] = await db
    .update(partnerMsa)
    .set({ effectiveTo: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(partnerMsa.tenantId, tenantId),
        eq(partnerMsa.partnerOrgId, partnerOrgId),
        isNull(partnerMsa.effectiveTo),
      ),
    )
    .returning({ id: partnerMsa.id });

  const isPercentage = input.feeModel === "percentage_ctc";
  const [row] = await db
    .insert(partnerMsa)
    .values({
      tenantId,
      partnerOrgId,
      feeModel: input.feeModel,
      // numeric(5,2) — fixed to the column's scale so what is read back is
      // exactly what was agreed, not a float that renders as 12.499999.
      feePercent: isPercentage && input.feePercent != null ? input.feePercent.toFixed(2) : null,
      flatFeeMinor: !isPercentage && input.flatFeeMinor != null ? BigInt(input.flatFeeMinor) : null,
      feeCurrency: input.feeCurrency,
      exclusivityWindowDays: input.exclusivityWindowDays,
      exclusivityScope: input.exclusivityScope,
      probationHoldbackPercent: input.probationHoldbackPercent.toFixed(2),
      replacementGuaranteeDays: input.replacementGuaranteeDays,
      createdByMembershipId: args.actorMembershipId,
    })
    .returning({ id: partnerMsa.id, effectiveFrom: partnerMsa.effectiveFrom });
  if (!row) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "partner_msa_insert_no_row" });
  }

  return {
    msaId: row.id,
    effectiveFrom: row.effectiveFrom.toISOString(),
    closedMsaId: closed?.id ?? null,
  };
}

// ──────────────────────────── fee reads ────────────────────────────

/**
 * Every fee accrued for one org, newest hire first, in the INTERNAL shape.
 * Both commercials surfaces run through this one query so they can never
 * disagree about a number; the partner projection below simply drops the two
 * fields that aren't theirs.
 *
 * The candidate name comes through the same name-only join
 * listPartnerOrgClaimsForTenant uses, and is nullable for the same reason (the
 * join, not the column, is what can come back empty). No email, no phone, no
 * offer amount: the fee is the number this surface is about.
 */
async function selectOrgFeeRows(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<PartnerOrgFeeRow[]> {
  const rows = await db
    .select({
      feeId: partnerFees.id,
      msaId: partnerFees.msaId,
      msaSnapshot: partnerFees.msaSnapshot,
      feeMinor: partnerFees.feeMinor,
      feeCurrency: partnerFees.feeCurrency,
      status: partnerFees.status,
      holdbackReleaseAt: partnerFees.holdbackReleaseAt,
      hiredAt: partnerFees.hiredAt,
      notes: partnerFees.notes,
      candidateName: persons.fullName,
      requisitionTitle: positions.title,
    })
    .from(partnerFees)
    .leftJoin(
      applications,
      and(
        eq(applications.tenantId, partnerFees.tenantId),
        eq(applications.id, partnerFees.applicationId),
      ),
    )
    .leftJoin(
      candidates,
      and(
        eq(candidates.tenantId, applications.tenantId),
        eq(candidates.id, applications.candidateId),
      ),
    )
    .leftJoin(
      persons,
      and(eq(persons.tenantId, candidates.tenantId), eq(persons.id, candidates.personId)),
    )
    .leftJoin(
      requisitions,
      and(
        eq(requisitions.tenantId, applications.tenantId),
        eq(requisitions.id, applications.requisitionId),
      ),
    )
    .leftJoin(
      positions,
      and(eq(positions.tenantId, requisitions.tenantId), eq(positions.id, requisitions.positionId)),
    )
    .where(and(eq(partnerFees.tenantId, tenantId), eq(partnerFees.partnerOrgId, partnerOrgId)))
    .orderBy(desc(partnerFees.hiredAt));

  return rows.map((r) => {
    const snapshot = (r.msaSnapshot ?? {}) as Partial<PartnerMsaSnapshot>;
    return {
      feeId: r.feeId,
      msaId: r.msaId,
      notes: r.notes,
      candidateName: r.candidateName ?? null,
      requisitionTitle: r.requisitionTitle ?? null,
      feeMinor: Number(r.feeMinor),
      feeCurrency: r.feeCurrency,
      status: r.status as PartnerOrgFeeRow["status"],
      holdbackReleaseAt: r.holdbackReleaseAt ? r.holdbackReleaseAt.toISOString() : null,
      hiredAt: r.hiredAt.toISOString(),
      // Frozen terms — the row says what it was computed under, not what the
      // current MSA says. A snapshot written before a field existed reads null
      // rather than being back-filled from today's terms.
      feeModel: (snapshot.feeModel as PartnerOrgFeeRow["feeModel"]) ?? null,
      feePercent: toNumberOrNull(snapshot.feePercent),
      flatFeeMinor: toNumberOrNull(snapshot.flatFeeMinor),
    };
  });
}

/**
 * The three totals both surfaces chip. Summed in JS over the rows we already
 * have rather than as a second grouped query: at POC scale it is the same
 * answer, and it guarantees the chips and the table below them are computed
 * from one and the same read.
 *
 * `disputed` counts toward none of the three — see partnerFeeRollupsSchema.
 */
function rollUpFees(fees: PartnerOrgFeeRow[], fallbackCurrency: string): PartnerFeeRollups {
  let accruedMinor = 0;
  let payableMinor = 0;
  let paidMinor = 0;
  for (const fee of fees) {
    if (fee.status === "accrued") accruedMinor += fee.feeMinor;
    else if (fee.status === "payable") payableMinor += fee.feeMinor;
    else if (fee.status === "paid") paidMinor += fee.feeMinor;
  }
  return {
    accruedMinor,
    payableMinor,
    paidMinor,
    currency: fees[0]?.feeCurrency ?? fallbackCurrency,
  };
}

/**
 * The INTERNAL commercials payload for one org: live terms, every fee, totals.
 * NOT_FOUND for another tenant's org, exactly as getPartnerOrgDetail answers.
 */
export async function getPartnerOrgCommercials(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<GetPartnerOrgCommercialsOutput> {
  await assertOrgInTenant(db, tenantId, partnerOrgId);
  const msa = await getLivePartnerMsa(db, tenantId, partnerOrgId);
  const fees = await selectOrgFeeRows(db, tenantId, partnerOrgId);
  return {
    msa: msa ? toMsaRow(msa) : null,
    fees,
    rollups: rollUpFees(fees, msa?.feeCurrency ?? "INR"),
  };
}

/**
 * The PARTNER-side projection of the same rows: msa_id and notes dropped on the
 * way out (see partnerFeeRowSchema for why), everything else identical —
 * including the per-row frozen terms, which are the partner's own contract.
 *
 * The org is the caller's, resolved from ctx.partner by the procedure, so there
 * is no org-existence check to make here: partnerProcedure has already proved
 * the org exists and that the caller belongs to it.
 */
export async function listPartnerFeesForOrg(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<PartnerGetCommercialsOutput> {
  const orgFees = await selectOrgFeeRows(db, tenantId, partnerOrgId);
  const msa = await getLivePartnerMsa(db, tenantId, partnerOrgId);
  // Built by NAMING the partner-visible fields rather than by spreading and
  // deleting: a future internal-only column then has to be added here on
  // purpose, instead of leaking the moment someone adds it to the row above.
  const fees: PartnerFeeRow[] = orgFees.map((f) => ({
    feeId: f.feeId,
    candidateName: f.candidateName,
    requisitionTitle: f.requisitionTitle,
    feeMinor: f.feeMinor,
    feeCurrency: f.feeCurrency,
    status: f.status,
    holdbackReleaseAt: f.holdbackReleaseAt,
    hiredAt: f.hiredAt,
    feeModel: f.feeModel,
    feePercent: f.feePercent,
    flatFeeMinor: f.flatFeeMinor,
  }));
  return { fees, rollups: rollUpFees(orgFees, msa?.feeCurrency ?? "INR") };
}

// ─────────────────────── accrual (offer accept) ───────────────────────

interface LiveMsaSqlRow {
  id: string;
  fee_model: string;
  fee_percent: string | null;
  flat_fee_minor: string | null;
  fee_currency: string;
  exclusivity_window_days: number;
  exclusivity_scope: string;
  probation_holdback_percent: string;
  replacement_guarantee_days: number;
}

/**
 * Accrue the partner's placement fee for a hire. Called from
 * runOfferAcceptSideEffects, on the same raw service-role client the workday
 * enqueue and the partner stage email use.
 *
 * BEST-EFFORT, always. The acceptance is committed before this runs, so every
 * exit is a log line and a return — never a throw. The honest exits:
 *
 *   - no partner on the application → nothing to accrue, and no log: the
 *     majority of hires are direct and that isn't an event.
 *   - a partner but NO live MSA → `partner_fee.no_msa`. An org whose terms
 *     were never agreed accrues nothing; inventing a default percentage here
 *     would be inventing a contract.
 *   - percentage terms but no readable offer → `partner_fee.offer_missing`.
 *     There is no annual base to take a percentage of.
 *   - unique violation on (tenant, application) → a retried accept. Clean
 *     no-op, logged at info, exactly the posture enqueueWorkdayHire takes.
 *
 * The fee itself is BIGINT arithmetic in minor units, rounded DOWN: the percent
 * becomes hundredths (20.00 → 2000) so `base * 2000 / 10000` is one integer
 * division, with no float ever touching the amount.
 */
export async function accruePartnerFeeOnHire(
  sql: PgSqlClient,
  args: { tenantId: string; applicationId: string; offerId: string; log: Logger },
): Promise<void> {
  const { tenantId, applicationId, offerId, log } = args;
  try {
    const [application] = await sql<{ source_partner_id: string | null }[]>`
      SELECT source_partner_id
      FROM public.applications
      WHERE tenant_id = ${tenantId} AND id = ${applicationId}
      LIMIT 1
    `;
    if (!application) {
      log.warn({ application_id: applicationId }, "partner_fee.application_missing");
      return;
    }
    const partnerOrgId = application.source_partner_id;
    if (!partnerOrgId) return; // direct application — nothing to accrue.

    const [msa] = await sql<LiveMsaSqlRow[]>`
      SELECT id, fee_model, fee_percent, flat_fee_minor, fee_currency,
             exclusivity_window_days, exclusivity_scope,
             probation_holdback_percent, replacement_guarantee_days
      FROM public.partner_msa
      WHERE tenant_id = ${tenantId}
        AND partner_org_id = ${partnerOrgId}
        AND effective_to IS NULL
      LIMIT 1
    `;
    if (!msa) {
      log.info(
        { application_id: applicationId, partner_org_id: partnerOrgId },
        "partner_fee.no_msa",
      );
      return;
    }

    const [offer] = await sql<
      { base_salary_inr_paise: string | number; accepted_at: string | Date | null }[]
    >`
      SELECT base_salary_inr_paise, accepted_at
      FROM public.offers
      WHERE tenant_id = ${tenantId} AND id = ${offerId}
      LIMIT 1
    `;

    let feeMinor: bigint;
    if (msa.fee_model === "percentage_ctc") {
      if (!offer) {
        log.error(
          { application_id: applicationId, offer_id: offerId },
          "partner_fee.offer_missing",
        );
        return;
      }
      const base = BigInt(String(offer.base_salary_inr_paise));
      const hundredths = BigInt(Math.round(Number(msa.fee_percent ?? 0) * 100));
      feeMinor = (base * hundredths) / 10_000n;
    } else {
      feeMinor = BigInt(String(msa.flat_fee_minor ?? 0));
    }

    // The hire date is the ACCEPTANCE, not "now" — a retried or late-running
    // side-effect pass must not drift the holdback window. Coerced through
    // new Date() rather than trusted: this is the raw postgres.js client, not
    // drizzle, and a timestamp that arrived as a string would otherwise poison
    // the holdback arithmetic silently.
    const hiredAt = offer?.accepted_at ? new Date(offer.accepted_at) : new Date();
    const holdbackReleaseAt = new Date(hiredAt.getTime() + msa.replacement_guarantee_days * DAY_MS);

    const snapshot: PartnerMsaSnapshot = {
      feeModel: msa.fee_model,
      feePercent: toNumberOrNull(msa.fee_percent),
      flatFeeMinor: toNumberOrNull(msa.flat_fee_minor),
      feeCurrency: msa.fee_currency,
      exclusivityWindowDays: msa.exclusivity_window_days,
      exclusivityScope: msa.exclusivity_scope,
      probationHoldbackPercent: Number(msa.probation_holdback_percent),
      replacementGuaranteeDays: msa.replacement_guarantee_days,
    };

    try {
      await sql`
        INSERT INTO public.partner_fees
          (tenant_id, partner_org_id, application_id, offer_id, msa_id, msa_snapshot,
           fee_minor, fee_currency, status, holdback_release_at, hired_at)
        VALUES
          (${tenantId}, ${partnerOrgId}, ${applicationId}, ${offer ? offerId : null}, ${msa.id},
           ${JSON.stringify(snapshot)}::jsonb, ${feeMinor.toString()}, ${msa.fee_currency},
           'accrued', ${holdbackReleaseAt.toISOString()}::timestamptz,
           ${hiredAt.toISOString()}::timestamptz)
      `;
    } catch (err) {
      if (isUniqueViolation(err)) {
        log.info({ application_id: applicationId }, "partner_fee.already_accrued");
        return;
      }
      throw err;
    }

    log.info(
      {
        application_id: applicationId,
        partner_org_id: partnerOrgId,
        fee_minor: feeMinor.toString(),
      },
      "partner_fee.accrued",
    );
  } catch (err) {
    // Nothing in this function may unwind a committed acceptance.
    log.error(
      { err, application_id: applicationId, offer_id: offerId },
      "partner_fee.accrual_failed",
    );
  }
}
