/**
 * HRHEAD-03 — Governance risk engine + Executive-Audit composites.
 *
 * Pure SQL/TS derivations over LIVE tenant tables. No AI, no demographic
 * anything, no migrations — every number here is read from existing rows.
 * Factored out of the tRPC router so the SQL stays readable and the whole
 * thing is unit-importable.
 *
 * Both entry points take a tenant-scoped drizzle client (`requireDb(ctx)`) and
 * the tenantId; RLS scopes every read and we add the explicit `tenant_id`
 * predicate belt-and-braces (same discipline as getHrMetrics).
 */

import { sql } from "drizzle-orm";
import { SLA_THRESHOLDS_HOURS } from "./sla-thresholds";
import type { ApplicationStage } from "@hireops/db";
import {
  REQUISITION_APPROVAL_SLA_DAYS,
  FEEDBACK_SLA_HOURS,
  UNREALISTIC_MUST_HAVE_THRESHOLD,
  COMPLIANCE_WEIGHTS,
  type GovernanceRiskFlag,
  type RiskRuleKey,
  type RiskSeverity,
  type ComplianceComponent,
  type SlaComplianceRow,
  type DropOffReason,
  type GetGovernanceRiskFlagsOutput,
  type GetExecutiveAuditOutput,
} from "@hireops/api-types";

// A minimal structural type for the tenant-bound drizzle client's execute().
interface ExecClient {
  execute(query: unknown): Promise<unknown>;
}

function asRows<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? (res as T[])) || [];
}

// Status sets as inline SQL fragments (fixed literals we control — no user
// input, so no injection surface). Written inline rather than bound as JS
// arrays because postgres' `= ANY($1)` binding of a JS array is brittle here.
const OPEN_REQ_STATUSES = sql`('draft', 'pending_approval', 'approved', 'posted')`;
const LIVE_OFFER_STATUSES = sql`('drafted', 'extended', 'accepted')`;

const STAGE_DROP_OFF_LABELS: Partial<Record<ApplicationStage, string>> = {
  recruiter_rejected: "Rejected by recruiter / at a stage gate",
  offer_declined: "Offer declined by candidate",
  withdrawn: "Candidate withdrew",
};

// ─────────────────────────── risk flags ───────────────────────────

/**
 * Run the five deterministic risk rules over live data. Rule (a) —
 * budget-below-benchmark — depends on `market_benchmarks`, which a concurrent
 * ticket (HRHEAD-02) is building; we probe for the relation and OMIT the rule
 * (recording it under skippedRules) when it is absent or its shape is
 * unexpected, rather than 500-ing.
 */
export async function computeGovernanceRiskFlags(
  db: ExecClient,
  tenantId: string,
): Promise<GetGovernanceRiskFlagsOutput> {
  const flags: GovernanceRiskFlag[] = [];
  const skippedRules: { rule: RiskRuleKey; reason: string }[] = [];

  const push = (
    rule: RiskRuleKey,
    severity: RiskSeverity,
    entityType: string,
    entityId: string | null,
    title: string,
    detail: string,
    consequence: string,
    deepLink: string | null,
  ) => {
    flags.push({
      id: `${rule}:${entityId ?? "na"}`,
      rule,
      severity,
      title,
      detail,
      consequence,
      entityType,
      entityId,
      deepLink,
    });
  };

  // (b) requisition pending approval > SLA days.
  const overdueRes = await db.execute(sql`
    SELECT ar.subject_id AS req_id,
           EXTRACT(EPOCH FROM (now() - ar.requested_at)) / 86400.0 AS days
    FROM public.approval_requests ar
    WHERE ar.tenant_id = ${tenantId}::uuid
      AND ar.subject_type = 'requisition'
      AND ar.status = 'pending'
      AND ar.requested_at < now() - (${REQUISITION_APPROVAL_SLA_DAYS} || ' days')::interval
    ORDER BY days DESC
  `);
  for (const row of asRows<{ req_id: string; days: number }>(overdueRes)) {
    const days = Math.floor(Number(row.days));
    push(
      "requisition_approval_overdue",
      "high",
      "requisition",
      row.req_id,
      "Requisition approval overdue",
      `Pending approval for ${days} day${days === 1 ? "" : "s"} (SLA is ${REQUISITION_APPROVAL_SLA_DAYS} days).`,
      "Hiring is blocked while the requisition waits; time-to-fill slips day for day.",
      "/requisition-approvals",
    );
  }

  // (c) >N must-have skills on an open req ("unrealistic must-haves").
  const mustHaveRes = await db.execute(sql`
    SELECT r.id AS req_id, COUNT(*)::int AS must_haves
    FROM public.requisitions r
    JOIN public.jd_skills s
      ON s.tenant_id = r.tenant_id
     AND s.jd_version_id = r.jd_version_id
     AND s.is_required = true
    WHERE r.tenant_id = ${tenantId}::uuid
      AND r.status IN ${OPEN_REQ_STATUSES}
    GROUP BY r.id
    HAVING COUNT(*) > ${UNREALISTIC_MUST_HAVE_THRESHOLD}
    ORDER BY COUNT(*) DESC
  `);
  for (const row of asRows<{ req_id: string; must_haves: number }>(mustHaveRes)) {
    push(
      "unrealistic_must_haves",
      "medium",
      "requisition",
      row.req_id,
      "Unrealistic must-have list",
      `${row.must_haves} skills flagged as required (threshold is ${UNREALISTIC_MUST_HAVE_THRESHOLD}).`,
      "Over-specified must-haves shrink the funnel and can screen out viable candidates.",
      `/requisitions/${row.req_id}`,
    );
  }

  // (d) offer above approved band (base salary over the position comp band max).
  const offerBandRes = await db.execute(sql`
    SELECT o.id AS offer_id, o.application_id AS application_id,
           (o.base_salary_inr_paise / 100.0) AS base_inr, p.comp_band_max AS band_max
    FROM public.offers o
    JOIN public.applications a ON a.tenant_id = o.tenant_id AND a.id = o.application_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    WHERE o.tenant_id = ${tenantId}::uuid
      AND o.status IN ${LIVE_OFFER_STATUSES}
      AND p.comp_band_max IS NOT NULL
      AND (o.base_salary_inr_paise / 100.0) > p.comp_band_max
    ORDER BY (o.base_salary_inr_paise / 100.0) - p.comp_band_max DESC
  `);
  for (const row of asRows<{ offer_id: string; application_id: string }>(offerBandRes)) {
    push(
      "offer_above_band",
      "high",
      "offer",
      row.offer_id,
      "Offer above approved band",
      "The offered base salary exceeds the position's approved comp band maximum.",
      "Out-of-band offers create pay-equity exposure and set an unbudgeted precedent.",
      `/triage?application=${row.application_id}`,
    );
  }

  // (e) interview feedback unsubmitted >48h past scheduled_end.
  const feedbackRes = await db.execute(sql`
    SELECT i.id AS interview_id, i.round_name AS round_name,
           EXTRACT(EPOCH FROM (now() - i.scheduled_end)) / 3600.0 AS hours
    FROM public.interviews i
    WHERE i.tenant_id = ${tenantId}::uuid
      AND i.scheduled_end IS NOT NULL
      AND i.scheduled_end < now() - (${FEEDBACK_SLA_HOURS} || ' hours')::interval
      AND i.status IN ('scheduled', 'completed')
      AND NOT EXISTS (
        SELECT 1 FROM public.interview_feedback f
        WHERE f.tenant_id = i.tenant_id AND f.interview_id = i.id AND f.submitted_at IS NOT NULL
      )
    ORDER BY hours DESC
  `);
  for (const row of asRows<{ interview_id: string; round_name: string; hours: number }>(
    feedbackRes,
  )) {
    const hours = Math.floor(Number(row.hours));
    push(
      "feedback_overdue",
      "medium",
      "interview",
      row.interview_id,
      `Feedback overdue — ${row.round_name}`,
      `No submitted feedback ${hours}h after the interview ended (SLA is ${FEEDBACK_SLA_HOURS}h).`,
      "Stalled feedback holds up the candidate's next step and erodes the experience.",
      "/interviews",
    );
  }

  // (a) req budget below benchmark median by >10% — DEFENSIVE, and run LAST.
  // `market_benchmarks` is built concurrently (HRHEAD-02) and we do not know
  // its final column shape. We PRE-CHECK the table + the exact columns we need
  // via information_schema so we never issue a statement that could fail and
  // poison the surrounding read transaction; a shape we don't recognise is
  // skipped cleanly. Assumed shape: (tenant_id, position_id, median_annual_comp).
  try {
    const shapeRes = await db.execute(sql`
      SELECT
        to_regclass('public.market_benchmarks') IS NOT NULL AS has_table,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'market_benchmarks'
            AND column_name = 'position_id'
        ) AS has_position_id,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'market_benchmarks'
            AND column_name = 'median_annual_comp'
        ) AS has_median
    `);
    const [shape] = asRows<{ has_table: boolean; has_position_id: boolean; has_median: boolean }>(
      shapeRes,
    );
    if (!shape?.has_table) {
      skippedRules.push({
        rule: "budget_below_benchmark",
        reason: "market_benchmarks table not present yet (HRHEAD-02)",
      });
    } else if (!shape.has_position_id || !shape.has_median) {
      skippedRules.push({
        rule: "budget_below_benchmark",
        reason:
          "market_benchmarks present but its columns differ from the assumed shape (position_id, median_annual_comp) — reconcile with HRHEAD-02",
      });
    } else {
      const benchRes = await db.execute(sql`
        SELECT r.id AS req_id, p.title AS title
        FROM public.requisitions r
        JOIN public.positions p
          ON p.tenant_id = r.tenant_id AND p.id = r.position_id
        JOIN public.market_benchmarks mb
          ON mb.tenant_id = r.tenant_id AND mb.position_id = p.id
        WHERE r.tenant_id = ${tenantId}::uuid
          AND r.status IN ${OPEN_REQ_STATUSES}
          AND p.comp_band_max IS NOT NULL
          AND mb.median_annual_comp IS NOT NULL
          AND p.comp_band_max < mb.median_annual_comp * 0.9
      `);
      for (const row of asRows<{ req_id: string; title: string }>(benchRes)) {
        push(
          "budget_below_benchmark",
          "medium",
          "requisition",
          row.req_id,
          `Budget below market for "${row.title}"`,
          "The approved comp band tops out more than 10% below the market benchmark median.",
          "Offers at this band risk losing candidates to better-paying competitors.",
          `/requisitions/${row.req_id}`,
        );
      }
    }
  } catch (err) {
    skippedRules.push({
      rule: "budget_below_benchmark",
      reason: `market_benchmarks check failed: ${(err as Error).message}`,
    });
  }

  const counts = tallySeverities(flags);
  return { flags, skippedRules, counts };
}

function tallySeverities(flags: GovernanceRiskFlag[]) {
  const counts = { high: 0, medium: 0, low: 0, total: flags.length };
  for (const f of flags) counts[f.severity] += 1;
  return counts;
}

// ─────────────────────────── executive audit ───────────────────────────

const COMPLIANCE_LABELS: Record<ComplianceComponent["key"], string> = {
  approvals_within_sla: "Approvals decided within SLA",
  feedback_within_48h: "Interview feedback within 48h",
  onboarding_docs_verified: "Onboarding documents verified",
  offers_within_band: "Offers within approved band",
};

interface RatioRow {
  numerator: number;
  denominator: number;
}

/** Empty sample counts as fully compliant (no activity → no breach). */
function ratioToComponent(key: ComplianceComponent["key"], row: RatioRow): ComplianceComponent {
  const denom = Number(row.denominator) || 0;
  const num = Number(row.numerator) || 0;
  const value = denom > 0 ? num / denom : 1;
  return {
    key,
    label: COMPLIANCE_LABELS[key],
    value: Math.max(0, Math.min(1, value)),
    weightPct: COMPLIANCE_WEIGHTS[key],
    sampleSize: denom,
  };
}

type SlaTableKey =
  | "requisition_approval"
  | "recruiter_review"
  | "tech_interview"
  | "interview_feedback"
  | "offer_decision";

const SLA_TABLE: Record<SlaTableKey, { label: string; targetHours: number }> = {
  requisition_approval: {
    label: "Requisition approval",
    targetHours: REQUISITION_APPROVAL_SLA_DAYS * 24,
  },
  recruiter_review: { label: "Recruiter review", targetHours: 48 },
  tech_interview: { label: "Technical interview stage", targetHours: 72 },
  interview_feedback: { label: "Interview feedback submission", targetHours: FEEDBACK_SLA_HOURS },
  offer_decision: { label: "Offer decision (extend → accept/decline)", targetHours: 24 },
};

export async function computeExecutiveAudit(
  db: ExecClient,
  tenantId: string,
): Promise<GetExecutiveAuditOutput> {
  // Compliance components — one ratio query each.
  const approvalsRes = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status IN ('approved', 'rejected') AND decided_at IS NOT NULL
      )::int AS denominator,
      COUNT(*) FILTER (
        WHERE status IN ('approved', 'rejected') AND decided_at IS NOT NULL
          AND decided_at - requested_at <= (${REQUISITION_APPROVAL_SLA_DAYS} || ' days')::interval
      )::int AS numerator
    FROM public.approval_requests
    WHERE tenant_id = ${tenantId}::uuid AND subject_type = 'requisition'
  `);

  const feedbackRes = await db.execute(sql`
    SELECT
      COUNT(*)::int AS denominator,
      COUNT(*) FILTER (
        WHERE f.submitted_at <= i.scheduled_end + (${FEEDBACK_SLA_HOURS} || ' hours')::interval
      )::int AS numerator
    FROM public.interview_feedback f
    JOIN public.interviews i ON i.tenant_id = f.tenant_id AND i.id = f.interview_id
    WHERE f.tenant_id = ${tenantId}::uuid
      AND f.submitted_at IS NOT NULL
      AND i.scheduled_end IS NOT NULL
  `);

  const docsRes = await db.execute(sql`
    SELECT
      COUNT(*)::int AS denominator,
      COUNT(*) FILTER (WHERE verification_status = 'verified')::int AS numerator
    FROM public.onboarding_documents
    WHERE tenant_id = ${tenantId}::uuid
  `);

  const bandRes = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE p.comp_band_min IS NOT NULL AND p.comp_band_max IS NOT NULL
      )::int AS denominator,
      COUNT(*) FILTER (
        WHERE p.comp_band_min IS NOT NULL AND p.comp_band_max IS NOT NULL
          AND (o.base_salary_inr_paise / 100.0) BETWEEN p.comp_band_min AND p.comp_band_max
      )::int AS numerator
    FROM public.offers o
    JOIN public.applications a ON a.tenant_id = o.tenant_id AND a.id = o.application_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    WHERE o.tenant_id = ${tenantId}::uuid AND o.status IN ${LIVE_OFFER_STATUSES}
  `);

  const components: ComplianceComponent[] = [
    ratioToComponent(
      "approvals_within_sla",
      asRows<RatioRow>(approvalsRes)[0] ?? { numerator: 0, denominator: 0 },
    ),
    ratioToComponent(
      "feedback_within_48h",
      asRows<RatioRow>(feedbackRes)[0] ?? { numerator: 0, denominator: 0 },
    ),
    ratioToComponent(
      "onboarding_docs_verified",
      asRows<RatioRow>(docsRes)[0] ?? { numerator: 0, denominator: 0 },
    ),
    ratioToComponent(
      "offers_within_band",
      asRows<RatioRow>(bandRes)[0] ?? { numerator: 0, denominator: 0 },
    ),
  ];

  const complianceScore = Math.round(components.reduce((acc, c) => acc + c.value * c.weightPct, 0));

  // Per-stage SLA table.
  const slaTable = await computeSlaTable(db, tenantId);

  // Top drop-off reasons — terminal-stage tallies.
  const dropOffRes = await db.execute(sql`
    SELECT current_stage AS stage, COUNT(*)::int AS count
    FROM public.applications
    WHERE tenant_id = ${tenantId}::uuid
      AND current_stage IN ('offer_declined', 'withdrawn', 'recruiter_rejected')
    GROUP BY current_stage
    ORDER BY COUNT(*) DESC
  `);
  const dropOff: DropOffReason[] = asRows<{ stage: ApplicationStage; count: number }>(
    dropOffRes,
  ).map((r) => ({
    stage: r.stage,
    label: STAGE_DROP_OFF_LABELS[r.stage] ?? r.stage,
    count: Number(r.count),
  }));

  // KPIs — SLA breaches (applications past their stage SLA now), offer accept
  // rate, plus the flag count + compliance score.
  const slaBreaches = await countSlaBreaches(db, tenantId);
  const offerRes = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
    FROM public.offers
    WHERE tenant_id = ${tenantId}::uuid
  `);
  const [{ accepted = 0, declined = 0 } = {}] = asRows<{ accepted: number; declined: number }>(
    offerRes,
  );
  const offerDecided = Number(accepted) + Number(declined);
  const offerAcceptRatePct =
    offerDecided > 0 ? Math.round((Number(accepted) / offerDecided) * 100) : null;

  const { flags, counts } = await computeGovernanceRiskFlags(db, tenantId);

  return {
    kpis: {
      complianceScore: Math.max(0, Math.min(100, complianceScore)),
      slaBreaches,
      openFlags: counts.total,
      offerAcceptRatePct,
    },
    components,
    slaTable,
    dropOff,
    flags,
    flagCounts: counts,
  };
}

async function computeSlaTable(db: ExecClient, tenantId: string): Promise<SlaComplianceRow[]> {
  // 1 — requisition approval turnaround.
  const approvalRes = await db.execute(sql`
    WITH d AS (
      SELECT EXTRACT(EPOCH FROM (decided_at - requested_at)) / 3600.0 AS hours
      FROM public.approval_requests
      WHERE tenant_id = ${tenantId}::uuid AND subject_type = 'requisition'
        AND status IN ('approved', 'rejected') AND decided_at IS NOT NULL
    )
    SELECT COUNT(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::float8 AS median,
           AVG((hours <= ${SLA_TABLE.requisition_approval.targetHours}::numeric)::int)::float8 AS within
    FROM d
  `);

  // 2 + 3 — stage dwell for recruiter_review + tech_interview.
  const dwellRes = await db.execute(sql`
    WITH ordered AS (
      SELECT to_stage AS stage, transitioned_at AS entered_at,
             LEAD(transitioned_at) OVER (
               PARTITION BY application_id ORDER BY transitioned_at
             ) AS left_at
      FROM public.application_state_transitions
      WHERE tenant_id = ${tenantId}::uuid
    ),
    d AS (
      SELECT stage, EXTRACT(EPOCH FROM (left_at - entered_at)) / 3600.0 AS hours
      FROM ordered
      WHERE left_at IS NOT NULL AND stage IN ('recruiter_review', 'tech_interview')
    )
    SELECT stage,
           COUNT(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::float8 AS median,
           AVG((hours <= (CASE stage WHEN 'recruiter_review' THEN ${SLA_TABLE.recruiter_review.targetHours}
                                    ELSE ${SLA_TABLE.tech_interview.targetHours} END)::numeric)::int)::float8 AS within
    FROM d
    GROUP BY stage
  `);

  // 4 — interview feedback submission latency.
  const fbRes = await db.execute(sql`
    WITH d AS (
      SELECT EXTRACT(EPOCH FROM (f.submitted_at - i.scheduled_end)) / 3600.0 AS hours
      FROM public.interview_feedback f
      JOIN public.interviews i ON i.tenant_id = f.tenant_id AND i.id = f.interview_id
      WHERE f.tenant_id = ${tenantId}::uuid AND f.submitted_at IS NOT NULL
        AND i.scheduled_end IS NOT NULL
    )
    SELECT COUNT(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::float8 AS median,
           AVG((hours <= ${SLA_TABLE.interview_feedback.targetHours}::numeric)::int)::float8 AS within
    FROM d
  `);

  // 5 — offer decision latency (extend → accept/decline).
  const offerRes = await db.execute(sql`
    WITH d AS (
      SELECT EXTRACT(EPOCH FROM (
               COALESCE(accepted_at, declined_at) - COALESCE(extended_at, created_at)
             )) / 3600.0 AS hours
      FROM public.offers
      WHERE tenant_id = ${tenantId}::uuid
        AND status IN ('accepted', 'declined')
        AND COALESCE(accepted_at, declined_at) IS NOT NULL
    )
    SELECT COUNT(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::float8 AS median,
           AVG((hours <= ${SLA_TABLE.offer_decision.targetHours}::numeric)::int)::float8 AS within
    FROM d
  `);

  const dwellByStage = new Map(
    asRows<{ stage: string; n: number; median: number | null; within: number | null }>(
      dwellRes,
    ).map((r) => [r.stage, r]),
  );

  const row = (
    key: SlaTableKey,
    src: { n: number; median: number | null; within: number | null } | undefined,
  ): SlaComplianceRow => {
    const t = SLA_TABLE[key];
    const n = Number(src?.n ?? 0);
    return {
      key,
      label: t.label,
      targetHours: t.targetHours,
      medianHours: src?.median == null ? null : Math.round(Number(src.median) * 10) / 10,
      withinTargetPct: n > 0 && src?.within != null ? Number(src.within) : null,
      sampleSize: n,
    };
  };

  return [
    row(
      "requisition_approval",
      asRows<{ n: number; median: number | null; within: number | null }>(approvalRes)[0],
    ),
    row("recruiter_review", dwellByStage.get("recruiter_review")),
    row("tech_interview", dwellByStage.get("tech_interview")),
    row(
      "interview_feedback",
      asRows<{ n: number; median: number | null; within: number | null }>(fbRes)[0],
    ),
    row(
      "offer_decision",
      asRows<{ n: number; median: number | null; within: number | null }>(offerRes)[0],
    ),
  ];
}

/** Count applications currently past their stage SLA (reuses the shared map). */
async function countSlaBreaches(db: ExecClient, tenantId: string): Promise<number> {
  const clauses = (Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][])
    .filter(([, hours]) => hours !== null)
    .map(
      ([stage, hours]) =>
        sql`WHEN current_stage = ${stage} THEN extract(epoch FROM (now() - stage_entered_at)) / 3600.0 > ${hours}`,
    );
  const breachExpr = sql`(CASE ${sql.join(clauses, sql.raw(" "))} ELSE false END)`;
  const res = await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE ${breachExpr})::int AS breaches
    FROM public.applications
    WHERE tenant_id = ${tenantId}::uuid
  `);
  const [{ breaches = 0 } = {}] = asRows<{ breaches: number }>(res);
  return Number(breaches);
}
