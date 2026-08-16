/**
 * Catalog report #7 — PARTNER / AGENCY SCORECARD (R1.3).
 *
 * "Which agencies are actually earning their fee?" — the third sponsor
 * question, and the first one the platform could only answer once the P2
 * commercials phase existed. Sourcing through partners is ~60% of intake
 * (HANDOVER §1), so a catalog with no partner row was reporting on 40% of
 * the funnel.
 *
 * ONE ROW PER PARTNER ORG. Active orgs ALWAYS appear, even at all zeros —
 * an empanelled partner who submitted nothing in the window is the finding,
 * and dropping the row would hide it. An INACTIVE org appears only when it
 * has activity in range, so a deactivated agency stops padding the table
 * the moment its history falls out of the window.
 *
 * THE DEFINITIONS THAT MATTER (each is restated on the wire schema):
 *
 *   - SUBMISSIONS are applications carrying `source_partner_id` — the
 *     FK-enforced attribution the partner submission flow writes — resolved
 *     through the SHARED application scope (`buildApplicationScope`), so
 *     "submissions in this period, in this BU" means exactly what it means
 *     on every other report in the catalog.
 *
 *   - SHORTLIST RATE is EVER-REACHED, not current stage: the share of those
 *     submissions with a transition INTO shortlisted / tech_interview /
 *     hr_round / offer_drafted / offer_accepted. A candidate who was
 *     shortlisted and then hired, or shortlisted and then rejected, still
 *     counts — the measure is "did the partner send someone worth talking
 *     to", and reading `current_stage` would erase every one of them. The
 *     price of that honesty: an application whose history was never
 *     recorded does not count, even if it currently sits past shortlisted.
 *
 *   - HIRES is the platform-wide definition (`current_stage =
 *     'offer_accepted'`), so this report reconciles with pipeline, aging,
 *     productivity and headcount rather than inventing a partner-only hire.
 *
 *   - DUPLICATE BLOCKED is the QUALITY signal, and the reason this report
 *     is not just a volume table: `candidate_dedup_attempts` rows with
 *     decision `block_active_claim` / `block_in_pipeline` — submissions the
 *     platform refused because someone else already owned the candidate.
 *     A partner with high submissions and high blocks is farming the
 *     pipeline, not sourcing for it. Attribution runs through
 *     `partner_users` (the attempt records the PERSON who tried, not their
 *     org — the same join `listPartnerOrgDedupAttemptsForTenant` uses),
 *     which also excludes internal-staff and public-apply attempts.
 *
 *   - FEES ACCRUED sums `partner_fees.fee_minor` over statuses accrued /
 *     payable / paid. `disputed` is deliberately EXCLUDED — it is precisely
 *     the amount the two parties do not agree on, and the P2.2 commercials
 *     rollups take the same line, so the two surfaces cannot disagree.
 *     Minor units cross the wire as a STRING (bigint, the `cost_micros`
 *     idiom); `feesCurrency` is null when nothing accrued in range.
 *
 *   - MEDIAN DAYS TO SUBMIT is the wireflows' time-to-submit KPI: per
 *     (org, requisition), the days from the org's EARLIEST assignment on
 *     that requisition to its FIRST submission on it, taken as a median
 *     across the org's pairs. Three consequences stated rather than hidden:
 *       · the "first submission" is the first one IN SCOPE, so a narrow
 *         window can overstate the gap when the real first submission sits
 *         outside it;
 *       · a submission on a requisition the org was never assigned to
 *         produces no pair (there is no clock to start);
 *       · durations are clamped at zero, so a submission recorded before
 *         its assignment cannot produce a negative.
 *
 * PERIOD SEMANTICS — three different date columns, one window, said out
 * loud here and on the surface:
 *   - submissions, both rates and the median-to-submit pairs are bounded on
 *     `applications.created_at` (the catalog's standard application axis);
 *   - fees are bounded on `partner_fees.hired_at` — a fee belongs to the
 *     month of the HIRE, which is the month a finance reader expects to be
 *     billed for, not the month the candidate applied;
 *   - duplicate blocks are bounded on `candidate_dedup_attempts.attempted_at`.
 * `activeAssignments` and `activeClaims` are CURRENT-STATE counts with no
 * window at all — "what does this partner hold right now".
 *
 * Filters:
 *   - businessUnitId narrows every REQUISITION-ANCHORED measure through the
 *     requisition → position path: assignments, submissions, both rates,
 *     the median pairs and fees.
 *   - requisitionId narrows the same set, plus duplicate blocks through the
 *     `submission_metadata->>'requisitionId'` pointer both writers record
 *     (a recorded pointer, NOT an FK — an attempt written without one would
 *     drop out of a requisition-filtered view).
 *   - `activeClaims` honours NEITHER: a claim is org↔person and attributes
 *     across requisitions by default (partner-data-model §ownership), so
 *     narrowing it by requisition or BU would report a number that does not
 *     mean what the column says. Duplicate blocks likewise ignore BU —
 *     resolving the metadata pointer into a business unit would mean using
 *     a non-FK jsonb field as a relational key.
 *   - recruiterMembershipId / source / stage are N/A. A partner is not a
 *     recruiter; source is already fixed by `source_partner_id IS NOT NULL`
 *     (filtering it again could only ever produce a self-contradiction);
 *     and a stage filter would silently redefine both rates. All three are
 *     ignored rather than half-applied, matching the published contract.
 *
 * House conventions inherited from R0.1/R0.2 — do not diverge: raw SQL at
 * request time inside the protected procedure's tenant transaction, an
 * explicit `tenant_id` predicate on top of RLS, ISO strings with
 * `::timestamptz` casts (never a JS Date — postgres-js cannot serialize
 * one as a raw text parameter), percentiles in Postgres, bigint money as
 * `::text`, ratios computed in JS.
 *
 * There is no row cap: a tenant empanels tens of agencies, not thousands,
 * so unlike the requisition list this cannot run away — and the client
 * derives its tiles from the full row set.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  GetPartnerScorecardReportOutput,
  PartnerScorecardRow,
  ReportFilters,
} from "@hireops/api-types";
import { buildApplicationScope } from "./dimensions";

/**
 * "Reached shortlisted or beyond" — the shortlist-rate numerator's stage
 * set, in canonical order. Deliberately excludes the three terminal
 * outcomes (offer_declined / withdrawn / recruiter_rejected): those say how
 * a candidate LEFT, not how far the partner got them.
 */
export const SHORTLISTED_OR_BEYOND_STAGES: readonly string[] = [
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

/**
 * Fee statuses that count as accrued money. `disputed` is excluded for the
 * same reason the P2.2 commercials rollups exclude it — see the header.
 */
export const COUNTED_FEE_STATUSES: readonly string[] = ["accrued", "payable", "paid"];

/** The two `dedup_decision` values that mean "we refused this submission". */
export const BLOCKING_DEDUP_DECISIONS: readonly string[] = [
  "block_active_claim",
  "block_in_pipeline",
];

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

interface ScorecardSqlRow {
  partner_org_id: string;
  org_name: string;
  tier: string;
  active: boolean;
  active_assignments: number;
  submissions: number;
  shortlisted: number;
  hires: number;
  duplicate_blocked: number;
  active_claims: number;
  fees_accrued_minor: string;
  fees_currency: string | null;
  median_days_to_submit: number | null;
}

/**
 * A count against a denominator, as a 1dp percentage; null when there is
 * nothing to divide by. Same shape as `utilisationPct` on the headcount
 * report — a rate over an empty set is unknown, not zero.
 */
export function ratePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * True when an org has anything worth a row. Only INACTIVE orgs are tested
 * against it (active ones always appear) — see the header.
 */
function hasActivity(r: ScorecardSqlRow): boolean {
  return (
    r.active_assignments > 0 ||
    r.submissions > 0 ||
    r.hires > 0 ||
    r.duplicate_blocked > 0 ||
    r.active_claims > 0 ||
    r.fees_accrued_minor !== "0"
  );
}

/**
 * The fee join chain: `partner_fees f → applications fa → requisitions fr →
 * positions fp`. Every hop exists for the BU / requisition filters; the
 * aliases are the ones `partnerFeeWhere` writes predicates against, so the
 * two are always used together.
 */
const PARTNER_FEE_FROM = dsql`
  FROM public.partner_fees f
  JOIN public.applications fa
    ON fa.tenant_id = f.tenant_id AND fa.id = f.application_id
  JOIN public.requisitions fr
    ON fr.tenant_id = fa.tenant_id AND fr.id = fa.requisition_id
  JOIN public.positions fp
    ON fp.tenant_id = fr.tenant_id AND fp.id = fr.position_id
`;

/**
 * THE fee predicate — counted statuses only, windowed on `hired_at` (a fee
 * belongs to the month of the HIRE, not of the application), narrowed by BU
 * and requisition through the join chain above.
 *
 * Exported and shared because the scorecard's per-org fee column and the
 * board pack's agency-spend tile MUST be the same money: two hand-rolled
 * copies of this predicate is exactly how a catalog starts disagreeing with
 * itself. recruiterMembershipId / source / stage are ignored here for the
 * reasons given in the header.
 */
export function partnerFeeWhere(tenantId: string, filters: ReportFilters): SQL {
  const clauses: SQL[] = [
    dsql`f.tenant_id = ${tenantId}::uuid`,
    dsql`f.status IN ('accrued', 'payable', 'paid')`,
  ];
  if (filters.from) clauses.push(dsql`f.hired_at >= ${filters.from}::timestamptz`);
  if (filters.to) clauses.push(dsql`f.hired_at <= ${filters.to}::timestamptz`);
  if (filters.businessUnitId) {
    clauses.push(dsql`fp.business_unit_id = ${filters.businessUnitId}::uuid`);
  }
  if (filters.requisitionId) {
    clauses.push(dsql`fa.requisition_id = ${filters.requisitionId}::uuid`);
  }
  return dsql.join(clauses, dsql` AND `);
}

/** Tenant-wide agency spend and the fee-bearing hires it was spent on. */
export interface AgencyFeeRollup {
  /** SUM(fee_minor) as a bigint string — "0" when nothing accrued in range. */
  agencySpendMinor: string;
  /** The accrued rows' currency; null when there are none, "MIXED" across currencies. */
  currency: string | null;
  /** COUNT of fee rows in range — one per partner-sourced hire that earned a fee. */
  agencyHires: number;
}

/**
 * DEFINITION — agency spend: the same fee rows the scorecard's
 * `feesAccruedMinor` column sums (`partnerFeeWhere`), rolled up across every
 * partner instead of per org, WITH the row count beside them.
 *
 * The count matters: it is the divisor for cost-per-agency-hire, and taking
 * it from the fee table rather than from the scorecard's `hires` column
 * keeps numerator and denominator on ONE population and ONE clock. The
 * scorecard's hires are partner-sourced applications windowed on the
 * APPLICATION date; these are fee-bearing hires windowed on the HIRE date.
 * Dividing one by the other would silently mix the two.
 *
 * `uniq_partner_fees_application` guarantees at most one fee per hire, so
 * the count cannot double.
 */
export async function agencyFeeRollup(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<AgencyFeeRollup> {
  const res = await db.execute(dsql`
    SELECT
      COALESCE(SUM(f.fee_minor), 0)::text AS agency_spend_minor,
      COUNT(*)::int AS agency_hires,
      COUNT(DISTINCT f.fee_currency)::int AS currencies,
      MIN(f.fee_currency) AS currency
    ${PARTNER_FEE_FROM}
    WHERE ${partnerFeeWhere(tenantId, filters)}
  `);
  const row = asRows<{
    agency_spend_minor: string;
    agency_hires: number;
    currencies: number;
    currency: string | null;
  }>(res)[0];

  return {
    agencySpendMinor: row?.agency_spend_minor ?? "0",
    // One currency per org is the POC's commercial reality (a fee inherits
    // it from the org's MSA); if a tenant ever mixes them the caller must
    // not add rupees to dollars, so the sum is labelled rather than named.
    currency: (row?.currencies ?? 0) > 1 ? "MIXED" : (row?.currency ?? null),
    agencyHires: row?.agency_hires ?? 0,
  };
}

/** The BU join path, requisition side: `… r → positions p`. Aliases match the CTEs below. */
const POSITION_JOIN = dsql`
  JOIN public.requisitions r
    ON r.tenant_id = pa.tenant_id AND r.id = pa.requisition_id
  JOIN public.positions p
    ON p.tenant_id = r.tenant_id AND p.id = r.position_id
`;

/**
 * DEFINITION — partner scorecard: for every partner organisation, the work
 * it holds (assignments, claims), the work it delivered (submissions,
 * shortlist rate, hires, hire rate), how fast it delivered it (median days
 * to submit), what it cost (fees accrued) and how much of its volume the
 * platform had to refuse (duplicate blocks). Busiest first (submissions
 * desc), then name A→Z.
 */
export async function getPartnerScorecardReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<GetPartnerScorecardReportOutput> {
  // The submission scope is the CATALOG's application scope, with the
  // dimensions this report does not honour dropped BEFORE the builder sees
  // them (the headcount report's discipline): letting the recruiter/source/
  // stage predicates through would narrow half this page while the
  // assignment and claim columns stayed put.
  const subScope = buildApplicationScope(tenantId, {
    from: filters.from,
    to: filters.to,
    businessUnitId: filters.businessUnitId,
    requisitionId: filters.requisitionId,
  });

  // Assignments: current-state, but still requisition-anchored, so BU and
  // requisition narrow them. The position join is only needed for BU;
  // it is unconditional because it also costs nothing.
  const assignmentClauses: SQL[] = [
    dsql`pa.tenant_id = ${tenantId}::uuid`,
    dsql`pa.status = 'active'`,
  ];
  if (filters.businessUnitId) {
    assignmentClauses.push(dsql`p.business_unit_id = ${filters.businessUnitId}::uuid`);
  }
  if (filters.requisitionId) {
    assignmentClauses.push(dsql`pa.requisition_id = ${filters.requisitionId}::uuid`);
  }

  // Duplicate blocks: windowed on attempted_at, narrowed by requisition
  // through the recorded metadata pointer only (see the header).
  const dedupClauses: SQL[] = [
    dsql`d.tenant_id = ${tenantId}::uuid`,
    dsql`d.decision IN ('block_active_claim', 'block_in_pipeline')`,
  ];
  if (filters.from) dedupClauses.push(dsql`d.attempted_at >= ${filters.from}::timestamptz`);
  if (filters.to) dedupClauses.push(dsql`d.attempted_at <= ${filters.to}::timestamptz`);
  if (filters.requisitionId) {
    dedupClauses.push(dsql`d.submission_metadata->>'requisitionId' = ${filters.requisitionId}`);
  }

  const res = await db.execute(dsql`
    WITH orgs AS (
      SELECT o.id AS id, o.name AS name, o.tier::text AS tier, o.active AS active
      FROM public.partner_orgs o
      WHERE o.tenant_id = ${tenantId}::uuid
    ),
    subs AS (
      SELECT
        a.source_partner_id AS org_id,
        a.requisition_id AS requisition_id,
        a.created_at AS created_at,
        (a.current_stage = 'offer_accepted') AS is_hire,
        EXISTS (
          SELECT 1
          FROM public.application_state_transitions t
          WHERE t.tenant_id = a.tenant_id
            AND t.application_id = a.id
            AND t.to_stage IN (
              'shortlisted', 'tech_interview', 'hr_round', 'offer_drafted', 'offer_accepted'
            )
        ) AS ever_shortlisted
      FROM public.applications a
      ${subScope.join}
      WHERE ${subScope.where}
        AND a.source_partner_id IS NOT NULL
    ),
    sub_stats AS (
      SELECT
        org_id,
        COUNT(*)::int AS submissions,
        COUNT(*) FILTER (WHERE ever_shortlisted)::int AS shortlisted,
        COUNT(*) FILTER (WHERE is_hire)::int AS hires
      FROM subs
      GROUP BY org_id
    ),
    assignments AS (
      SELECT pa.partner_org_id AS org_id, COUNT(*)::int AS active_assignments
      FROM public.partner_assignments pa
      ${POSITION_JOIN}
      WHERE ${dsql.join(assignmentClauses, dsql` AND `)}
      GROUP BY pa.partner_org_id
    ),
    claims AS (
      SELECT c.partner_org_id AS org_id, COUNT(*)::int AS active_claims
      FROM public.candidate_ownership_claims c
      WHERE c.tenant_id = ${tenantId}::uuid
        AND c.status = 'active'
      GROUP BY c.partner_org_id
    ),
    dedup AS (
      SELECT pu.partner_org_id AS org_id, COUNT(*)::int AS duplicate_blocked
      FROM public.candidate_dedup_attempts d
      JOIN public.partner_users pu
        ON pu.tenant_id = d.tenant_id AND pu.id = d.attempted_by_partner_user_id
      WHERE ${dsql.join(dedupClauses, dsql` AND `)}
      GROUP BY pu.partner_org_id
    ),
    fees AS (
      -- Window / status / dimension rules come from the SHARED predicate,
      -- so this column and the board pack's agency-spend tile are the same
      -- money by construction.
      SELECT
        f.partner_org_id AS org_id,
        SUM(f.fee_minor)::text AS fees_accrued_minor,
        MIN(f.fee_currency) AS fees_currency
      ${PARTNER_FEE_FROM}
      WHERE ${partnerFeeWhere(tenantId, filters)}
      GROUP BY f.partner_org_id
    ),
    pairs AS (
      -- One (org, requisition) pair per assignment the org actually
      -- submitted against. The join can fan out over several assignments
      -- (assign → end → re-assign); MIN() on both sides is unaffected.
      SELECT
        s.org_id AS org_id,
        GREATEST(
          EXTRACT(EPOCH FROM (MIN(s.created_at) - MIN(pa.assigned_at))) / 86400.0,
          0
        ) AS days_to_submit
      FROM subs s
      JOIN public.partner_assignments pa
        ON pa.tenant_id = ${tenantId}::uuid
       AND pa.partner_org_id = s.org_id
       AND pa.requisition_id = s.requisition_id
      GROUP BY s.org_id, s.requisition_id
    ),
    speed AS (
      SELECT
        org_id,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_submit)::numeric, 2)::float8
          AS median_days_to_submit
      FROM pairs
      GROUP BY org_id
    )
    SELECT
      orgs.id::text AS partner_org_id,
      orgs.name AS org_name,
      orgs.tier AS tier,
      orgs.active AS active,
      COALESCE(assignments.active_assignments, 0)::int AS active_assignments,
      COALESCE(sub_stats.submissions, 0)::int AS submissions,
      COALESCE(sub_stats.shortlisted, 0)::int AS shortlisted,
      COALESCE(sub_stats.hires, 0)::int AS hires,
      COALESCE(dedup.duplicate_blocked, 0)::int AS duplicate_blocked,
      COALESCE(claims.active_claims, 0)::int AS active_claims,
      COALESCE(fees.fees_accrued_minor, '0') AS fees_accrued_minor,
      fees.fees_currency AS fees_currency,
      speed.median_days_to_submit AS median_days_to_submit
    FROM orgs
    LEFT JOIN sub_stats ON sub_stats.org_id = orgs.id
    LEFT JOIN assignments ON assignments.org_id = orgs.id
    LEFT JOIN claims ON claims.org_id = orgs.id
    LEFT JOIN dedup ON dedup.org_id = orgs.id
    LEFT JOIN fees ON fees.org_id = orgs.id
    LEFT JOIN speed ON speed.org_id = orgs.id
    ORDER BY COALESCE(sub_stats.submissions, 0) DESC, orgs.name ASC
  `);

  const rows: PartnerScorecardRow[] = asRows<ScorecardSqlRow>(res)
    .filter((r) => r.active || hasActivity(r))
    .map((r) => ({
      partnerOrgId: r.partner_org_id,
      orgName: r.org_name,
      tier: r.tier,
      active: r.active,
      activeAssignments: r.active_assignments,
      submissions: r.submissions,
      shortlistRate: ratePct(r.shortlisted, r.submissions),
      hires: r.hires,
      hireRate: ratePct(r.hires, r.submissions),
      duplicateBlocked: r.duplicate_blocked,
      activeClaims: r.active_claims,
      feesAccruedMinor: r.fees_accrued_minor,
      feesCurrency: r.fees_currency,
      medianDaysToSubmit: r.median_days_to_submit,
    }));

  return { rows };
}
