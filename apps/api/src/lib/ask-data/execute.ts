/**
 * "Ask your data" — the deterministic EXECUTORS (ASK-DATA).
 *
 * One executor per catalog intent. Every figure comes from the reporting
 * semantic layer (lib/reports — the same measures and report libs the /reports
 * catalog renders), so an answer here cannot disagree with the matching
 * report. The summary sentence is built HERE, from the numbers, never by the
 * model; the footnote names the source and the definition.
 *
 * Only three small queries are new, each because no report exposes the row
 * list the question asks for: the declined-offer list, the pending-approval
 * list, and the role-title lookup for joiners. They follow the house
 * conventions (raw SQL inside the protected procedure's tenant transaction,
 * explicit tenant predicate on top of RLS, ISO bounds with ::timestamptz).
 *
 * Hiring-manager scoping (see HIRING_MANAGER_SCOPE) is applied by the caller
 * for `requisition` intents (a single own requisition in the filters) and
 * here for `rows` / `sql` intents via `hmRequisitionIds` / `hmMembershipId`.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type {
  AskDataColumn,
  AskDataIntentId,
  AskDataResult,
  ReportFilters,
} from "@hireops/api-types";

import * as measures from "../reports/measures";
import { getRequisitionAgingReport } from "../reports/requisition-aging";
import { getRecruiterProductivityReport } from "../reports/recruiter-productivity";
import { getApprovalAnalyticsReport } from "../reports/approval-analytics";
import { getPartnerScorecardReport } from "../reports/partner-scorecard";
import { getInterviewHealthReport } from "../reports/interview-health";
import { getOnboardingReadinessReport } from "../reports/onboarding-readiness";
import type { AskDataLookups, NamedItem, ResolvedAskDataFilters } from "./interpret";

export interface AskDataExecDeps {
  db: TenantBoundDb;
  tenantId: string;
  /** Membership display names (service-role; public.users is self-only under RLS). */
  resolveNames: (membershipIds: string[]) => Promise<Map<string, string | null>>;
  /** Candidate names on declined offers — admin / HR roles only. */
  canSeeCandidateNames: boolean;
  /** Set ⇒ the caller is hiring-manager scoped to these (own) requisitions. */
  hmMembershipId: string | null;
  hmRequisitionIds: ReadonlySet<string> | null;
}

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

// ─────────────────────────────── tenant lookups ───────────────────────────────

/** Requisition statuses that count as OPEN for this page (drafts are not yet open). */
export const OPEN_REQUISITION_STATUSES: readonly string[] = [
  "pending_approval",
  "approved",
  "on_hold",
  "posted",
];

/**
 * The names the interpreter resolves against: active business units, and the
 * open requisitions the caller may ask about (a hiring manager's own only).
 */
export async function loadAskDataLookups(
  db: TenantBoundDb,
  tenantId: string,
  hmMembershipId: string | null,
): Promise<AskDataLookups> {
  const buRes = await db.execute(dsql`
    SELECT b.id::text AS id, b.name AS name
    FROM public.business_units b
    WHERE b.tenant_id = ${tenantId}::uuid AND b.is_archived = false
    ORDER BY b.name ASC
  `);
  const hmClause = hmMembershipId
    ? dsql`AND r.hiring_manager_id = ${hmMembershipId}::uuid`
    : dsql``;
  const reqRes = await db.execute(dsql`
    SELECT r.id::text AS id, p.title AS name
    FROM public.requisitions r
    JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    WHERE r.tenant_id = ${tenantId}::uuid
      AND r.status IN ('pending_approval', 'approved', 'on_hold', 'posted')
      ${hmClause}
    ORDER BY r.created_at DESC
    LIMIT 200
  `);
  return {
    businessUnits: asRows<NamedItem>(buRes),
    requisitions: asRows<NamedItem>(reqRes),
  };
}

// ─────────────────────────────── formatting helpers ───────────────────────────────

/** Staff stage wording — mirrors the portal's applicationStageLabel. */
const STAGE_LABELS: Record<string, string> = {
  application_received: "Applied",
  ai_screening: "AI screening",
  recruiter_review: "Recruiter review",
  shortlisted: "Shortlisted",
  tech_interview: "Panel interview",
  hr_round: "HR round",
  offer_drafted: "Offer drafted",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  withdrawn: "Withdrawn",
  recruiter_rejected: "Rejected",
};
const TERMINAL_STAGES = new Set([
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);

const SOURCE_LABELS: Record<string, string> = {
  career_site: "Career site",
  referral: "Referral",
  partner_empanelled: "Empanelled partner",
  partner_adhoc: "Ad-hoc partner",
  job_board: "Job board",
  agency_search: "Agency search",
  talent_pool: "Talent pool",
  whatsapp: "WhatsApp",
};

/** snake_case → "Sentence case". */
function humanize(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round1((numerator / denominator) * 100) : null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function fmtDays(n: number): string {
  return `${round1(n)} ${round1(n) === 1 ? "day" : "days"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10" → "Oct 2026". */
function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** A Date / ISO string → "YYYY-MM-DD" (UTC). */
function isoDay(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function col(key: string, label: string, format: AskDataColumn["format"]): AskDataColumn {
  return { key, label, format };
}

/** The standard report filters an application-axis executor reads. */
function reportFilters(f: ResolvedAskDataFilters): ReportFilters {
  return {
    from: f.window.from,
    to: f.window.to,
    businessUnitId: f.businessUnitId,
    requisitionId: f.requisitionId,
  };
}

/** "in Finance", "on Senior Accountant", "" — appended to summaries. */
function scopePhrase(f: ResolvedAskDataFilters): string {
  const parts: string[] = [];
  if (f.requisitionTitle) parts.push(`on ${f.requisitionTitle}`);
  if (f.businessUnitName) parts.push(`in ${f.businessUnitName}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

type Executor = (deps: AskDataExecDeps, f: ResolvedAskDataFilters) => Promise<AskDataResult>;

// ─────────────────────────────── requisitions ───────────────────────────────

/** Open requisitions in scope, from the aging report (oldest first). */
async function openAgingRows(deps: AskDataExecDeps, f: ResolvedAskDataFilters) {
  const report = await getRequisitionAgingReport(deps.db, deps.tenantId, {
    businessUnitId: f.businessUnitId,
  });
  const rows = report.rows.filter(
    (r) =>
      OPEN_REQUISITION_STATUSES.includes(r.status) &&
      (!deps.hmRequisitionIds || deps.hmRequisitionIds.has(r.requisitionId)),
  );
  return { rows, truncated: report.truncated };
}

const openReqsByBu: Executor = async (deps, f) => {
  const { rows, truncated } = await openAgingRows(deps, f);
  const byBu = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const counts = byBu.get(r.businessUnitName) ?? { total: 0 };
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    counts.total = (counts.total ?? 0) + 1;
    byBu.set(r.businessUnitName, counts);
  }
  const table = [...byBu.entries()]
    .map(([bu, c]) => ({
      business_unit: bu,
      posted: c.posted ?? 0,
      approved: c.approved ?? 0,
      pending_approval: c.pending_approval ?? 0,
      on_hold: c.on_hold ?? 0,
      total: c.total ?? 0,
    }))
    .sort((a, b) => b.total - a.total || a.business_unit.localeCompare(b.business_unit));

  const total = rows.length;
  const posted = rows.filter((r) => r.status === "posted").length;
  const pending = rows.filter((r) => r.status === "pending_approval").length;
  const top = table[0];
  const summary =
    total === 0
      ? `There are no open requisitions${scopePhrase(f)}.`
      : `There ${total === 1 ? "is" : "are"} ${plural(total, "open requisition")} across ${plural(table.length, "business unit")}: ${posted} posted and ${pending} awaiting approval.` +
        (top && table.length > 1 ? ` ${top.business_unit} has the most (${top.total}).` : "");

  return {
    title: "Open requisitions by business unit",
    kind: "bar",
    columns: [
      col("business_unit", "Business unit", "text"),
      col("posted", "Posted", "number"),
      col("approved", "Approved", "number"),
      col("pending_approval", "Pending approval", "number"),
      col("on_hold", "On hold", "number"),
      col("total", "Total open", "number"),
    ],
    rows: table,
    chart: { x: "business_unit", y: ["total"] },
    summary,
    footnote:
      "Source: requisitions (Requisition status & aging report). Open = pending approval, approved, on hold or posted; drafts, filled, cancelled and closed requisitions are excluded. Current snapshot." +
      (truncated ? " Over 500 requisitions in scope — only the 500 oldest are counted." : ""),
    empty: total === 0,
  };
};

const oldestOpenReqs: Executor = async (deps, f) => {
  const { rows } = await openAgingRows(deps, f);
  const top = rows.slice(0, 10);
  const names = await deps.resolveNames(top.map((r) => r.recruiterMembershipId));
  const table = top.map((r) => ({
    requisition: r.title,
    business_unit: r.businessUnitName,
    status: humanize(r.status),
    recruiter: names.get(r.recruiterMembershipId) ?? "—",
    opened: isoDay(r.createdAt),
    days_open: Math.floor(r.daysOpen),
  }));
  const first = top[0];
  const avg = top.length ? top.reduce((s, r) => s + r.daysOpen, 0) / top.length : 0;
  const summary = first
    ? `The longest-open requisition is ${first.title} (${first.businessUnitName}) at ${Math.floor(first.daysOpen)} days.` +
      (top.length > 1
        ? ` These ${top.length} have been open for ${Math.round(avg)} days on average.`
        : "")
    : `There are no open requisitions${scopePhrase(f)}.`;
  return {
    title: "Longest-open requisitions",
    kind: "table",
    columns: [
      col("requisition", "Requisition", "text"),
      col("business_unit", "Business unit", "text"),
      col("status", "Status", "text"),
      col("recruiter", "Recruiter", "text"),
      col("opened", "Opened", "date"),
      col("days_open", "Days open", "number"),
    ],
    rows: table,
    summary,
    footnote:
      "Source: requisitions (Requisition status & aging report). Days open = days since the requisition was raised. Open = pending approval, approved, on hold or posted. Top 10 shown.",
    empty: top.length === 0,
  };
};

const timeToFill: Executor = async (deps, f) => {
  const s = await measures.timeToFillStats(deps.db, deps.tenantId, reportFilters(f));
  const median = s.median_days;
  const empty = s.hires_count === 0 || median === null;
  const summary =
    s.hires_count === 0 || median === null
      ? `No hires${scopePhrase(f)} in this period, so there is no time to fill to report.`
      : `Median time to fill was ${fmtDays(median)} across ${plural(s.hires_count, "hire")}${scopePhrase(f)}` +
        (s.p90_days !== null ? ` (90% of hires took ${fmtDays(s.p90_days)} or less).` : ".");
  return {
    title: "Time to fill",
    kind: "kpi",
    columns: [
      col("median_days", "Median days to fill", "days"),
      col("p90_days", "90th percentile", "days"),
      col("hires", "Hires", "number"),
    ],
    rows: [
      {
        median_days: s.median_days === null ? null : round1(s.median_days),
        p90_days: s.p90_days === null ? null : round1(s.p90_days),
        hires: s.hires_count,
      },
    ],
    summary,
    footnote:
      "Source: applications and stage history (Pipeline & speed report). Time to fill = days from application to its accepted offer, for applications created in the period. Reported as the median (the typical hire), which a few very slow hires cannot skew the way an average can.",
    empty,
  };
};

const timeToFillTrend: Executor = async (deps, f) => {
  const months = f.months ?? 6;
  const points = await measures.timeToFillTrend(
    deps.db,
    deps.tenantId,
    { businessUnitId: f.businessUnitId, requisitionId: f.requisitionId },
    { months },
  );
  const rows = points.map((p) => ({
    month: monthLabel(p.month),
    median_days: p.medianDays === null ? null : round1(p.medianDays),
    hires: p.hires,
  }));
  const withData = points.flatMap((p) =>
    p.medianDays === null ? [] : [{ month: p.month, hires: p.hires, median: p.medianDays }],
  );
  const totalHires = points.reduce((s, p) => s + p.hires, 0);
  const first = withData[0];
  const last = withData[withData.length - 1];
  let summary: string;
  if (!first || !last) {
    summary = `No hires${scopePhrase(f)} in the last ${months} months.`;
  } else if (first === last) {
    summary = `Only ${monthLabel(first.month)} had hires${scopePhrase(f)} in the last ${months} months: a median of ${fmtDays(first.median)} over ${plural(first.hires, "hire")}.`;
  } else {
    const dir =
      last.median < first.median
        ? "improved"
        : last.median > first.median
          ? "slowed"
          : "held steady";
    summary = `Median time to fill ${dir}${scopePhrase(f)}: ${fmtDays(first.median)} in ${monthLabel(first.month)} to ${fmtDays(last.median)} in ${monthLabel(last.month)}, over ${plural(totalHires, "hire")} in the last ${months} months.`;
  }
  return {
    title: `Time to fill — last ${months} months`,
    kind: "line",
    columns: [
      col("month", "Month", "text"),
      col("median_days", "Median days to fill", "days"),
      col("hires", "Hires", "number"),
    ],
    rows,
    chart: { x: "month", y: ["median_days"] },
    summary,
    footnote:
      "Source: applications and stage history (Executive summary trend). Each month = the hires that landed in that month; median days from application to accepted offer. Months with no hires show no value (unknown, not zero).",
    empty: withData.length === 0,
  };
};

// ─────────────────────────────── pipeline ───────────────────────────────

const pipelineFunnel: Executor = async (deps, f) => {
  const funnel = await measures.funnelByStage(deps.db, deps.tenantId, reportFilters(f));
  const rows = funnel.map((b) => ({
    stage: STAGE_LABELS[b.stage] ?? humanize(b.stage),
    candidates: b.count,
  }));
  const total = funnel.reduce((s, b) => s + b.count, 0);
  const active = funnel.filter((b) => !TERMINAL_STAGES.has(b.stage));
  const activeTotal = active.reduce((s, b) => s + b.count, 0);
  const busiest = [...active].sort((a, b) => b.count - a.count)[0];
  const hired = funnel.find((b) => b.stage === "offer_accepted")?.count ?? 0;
  const summary =
    total === 0
      ? `No candidates${scopePhrase(f)} in this period.`
      : `${plural(total, "candidate")}${scopePhrase(f)}: ${activeTotal.toLocaleString("en-US")} still in the pipeline` +
        (busiest && busiest.count > 0
          ? `, the largest group at ${STAGE_LABELS[busiest.stage] ?? busiest.stage} (${busiest.count})`
          : "") +
        `, and ${plural(hired, "hire")}.`;
  return {
    title: "Hiring funnel",
    kind: "bar",
    columns: [col("stage", "Stage", "text"), col("candidates", "Candidates", "number")],
    rows,
    chart: { x: "stage", y: ["candidates"] },
    summary,
    footnote:
      "Source: applications (Pipeline & speed report). Each candidate is counted once, at the stage they are in now — a snapshot, not a cumulative 'ever reached' count. Period = when the application was created.",
    empty: total === 0,
  };
};

const stageBottlenecks: Executor = async (deps, f) => {
  const stages = await measures.timeInStageMedians(deps.db, deps.tenantId, reportFilters(f));
  const withData = stages.flatMap((s) =>
    s.days === null ? [] : [{ stage: s.stage, days: s.days }],
  );
  const rows = withData.map((s) => ({
    stage: STAGE_LABELS[s.stage] ?? humanize(s.stage),
    median_days: round1(s.days),
  }));
  const slowest = [...withData].sort((a, b) => b.days - a.days)[0];
  const summary = slowest
    ? `Candidates wait longest at ${STAGE_LABELS[slowest.stage] ?? slowest.stage}${scopePhrase(f)}: a median of ${fmtDays(slowest.days)} before moving on.`
    : `No completed stage moves${scopePhrase(f)} in this period yet.`;
  return {
    title: "Where candidates get stuck",
    kind: "bar",
    columns: [col("stage", "Stage", "text"), col("median_days", "Median days in stage", "days")],
    rows,
    chart: { x: "stage", y: ["median_days"] },
    summary,
    footnote:
      "Source: stage history (Pipeline & speed report). Median days between entering a stage and leaving it, over completed visits only — candidates still sitting in a stage are not yet counted, and final stages are never left. Period = when the application was created.",
    empty: withData.length === 0,
  };
};

const hiresBySource: Executor = async (deps, f) => {
  const mix = await measures.sourceMix(deps.db, deps.tenantId, reportFilters(f));
  const rows = mix
    .map((m) => ({
      source: SOURCE_LABELS[m.source] ?? humanize(m.source),
      applications: m.applications,
      hires: m.hires,
      conversion: pct(m.hires, m.applications),
    }))
    .sort((a, b) => b.hires - a.hires || b.applications - a.applications);
  const totalHires = mix.reduce((s, m) => s + m.hires, 0);
  const totalApps = mix.reduce((s, m) => s + m.applications, 0);
  const top = rows[0];
  let summary: string;
  if (totalApps === 0) summary = `No applications${scopePhrase(f)} in this period.`;
  else if (totalHires === 0 || !top)
    summary = `No hires${scopePhrase(f)} in this period yet; ${plural(totalApps, "application")} so far, most from ${[...rows].sort((a, b) => b.applications - a.applications)[0]?.source}.`;
  else
    summary = `${top.source} produced the most hires${scopePhrase(f)}: ${top.hires} of ${totalHires} (${pct(top.hires, totalHires)}%).`;
  return {
    title: "Hires by source",
    kind: "bar",
    columns: [
      col("source", "Source", "text"),
      col("applications", "Applications", "number"),
      col("hires", "Hires", "number"),
      col("conversion", "Hire rate", "percent"),
    ],
    rows,
    chart: { x: "source", y: ["hires"] },
    summary,
    footnote:
      "Source: applications (Pipeline & speed report). Hire = application at Offer accepted. Hire rate = hires ÷ applications from that source. Period = when the application was created.",
    empty: totalApps === 0,
  };
};

const pendingFeedback: Executor = async (deps, f) => {
  const report = await getInterviewHealthReport(deps.db, deps.tenantId, reportFilters(f));
  const sc = report.scorecardCompletion;
  const names = await deps.resolveNames(sc.laggards.map((l) => l.membershipId));
  const rows = sc.laggards.map((l) => ({
    panelist: names.get(l.membershipId) ?? "Unknown panelist",
    outstanding: l.outstanding,
  }));
  const outstanding = sc.expectedScorecards - sc.submittedScorecards;
  let summary: string;
  if (sc.expectedScorecards === 0)
    summary = `No completed interviews with a panel${scopePhrase(f)} in this period.`;
  else if (outstanding === 0)
    summary = `All ${plural(sc.expectedScorecards, "expected scorecard")} for ${plural(sc.interviewsCompleted, "completed interview")}${scopePhrase(f)} have been submitted.`;
  else
    summary =
      `${plural(outstanding, "scorecard")} still outstanding across ${plural(sc.interviewsCompleted, "completed interview")}${scopePhrase(f)} — ${sc.submittedScorecards} of ${sc.expectedScorecards} submitted (${sc.completionRate ?? 0}%).` +
      (rows[0] ? ` ${rows[0].panelist} owes the most (${rows[0].outstanding}).` : "");
  return {
    title: "Interviews waiting for panel feedback",
    kind: "table",
    columns: [
      col("panelist", "Panelist", "text"),
      col("outstanding", "Scorecards outstanding", "number"),
    ],
    rows,
    summary,
    footnote:
      "Source: interviews, panelists and scorecards (Interview & scorecard health report). One scorecard is expected per panelist on each completed interview; drafts don't count. Shows the ten panelists owing the most. Period = interview date.",
    empty: sc.expectedScorecards === 0,
  };
};

// ─────────────────────────────── offers & joiners ───────────────────────────────

const offerAcceptance: Executor = async (deps, f) => {
  const o = await measures.offerFunnel(deps.db, deps.tenantId, reportFilters(f));
  const answered = o.accepted + o.declined;
  const rate = pct(o.accepted, answered);
  const summary =
    o.extended === 0
      ? `No offers extended${scopePhrase(f)} in this period.`
      : answered === 0
        ? `${plural(o.extended, "offer")} extended${scopePhrase(f)}; none answered yet.`
        : `${rate}% of answered offers were accepted${scopePhrase(f)}: ${o.accepted} accepted and ${o.declined} declined, out of ${plural(o.extended, "offer")} extended.`;
  return {
    title: "Offer acceptance",
    kind: "kpi",
    columns: [
      col("acceptance_rate", "Acceptance rate", "percent"),
      col("extended", "Offers extended", "number"),
      col("accepted", "Accepted", "number"),
      col("declined", "Declined", "number"),
    ],
    rows: [
      { acceptance_rate: rate, extended: o.extended, accepted: o.accepted, declined: o.declined },
    ],
    summary,
    footnote:
      "Source: offers (Pipeline & speed report). Acceptance rate = accepted ÷ (accepted + declined) — offers still awaiting an answer are left out. Period = when the candidate's application was created.",
    empty: o.extended === 0 && o.drafted === 0,
  };
};

interface DeclinedSqlRow {
  role: string;
  business_unit: string | null;
  declined_on: Date | string | null;
  reason: string | null;
  candidate: string | null;
}

const declinedOffers: Executor = async (deps, f) => {
  const clauses: SQL[] = [dsql`o.tenant_id = ${deps.tenantId}::uuid`, dsql`o.status = 'declined'`];
  if (f.window.from) {
    clauses.push(dsql`COALESCE(o.declined_at, o.updated_at) >= ${f.window.from}::timestamptz`);
  }
  if (f.window.to) {
    clauses.push(dsql`COALESCE(o.declined_at, o.updated_at) <= ${f.window.to}::timestamptz`);
  }
  if (f.businessUnitId) clauses.push(dsql`p.business_unit_id = ${f.businessUnitId}::uuid`);
  if (deps.hmMembershipId) clauses.push(dsql`r.hiring_manager_id = ${deps.hmMembershipId}::uuid`);
  // Candidate names are only joined at all for roles allowed to see them.
  const nameSelect = deps.canSeeCandidateNames ? dsql`pe.full_name` : dsql`NULL::text`;
  const nameJoin = deps.canSeeCandidateNames
    ? dsql`
      LEFT JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
      LEFT JOIN public.persons pe ON pe.tenant_id = c.tenant_id AND pe.id = c.person_id`
    : dsql``;
  const res = await deps.db.execute(dsql`
    SELECT
      p.title AS role,
      b.name AS business_unit,
      COALESCE(o.declined_at, o.updated_at) AS declined_on,
      NULLIF(btrim(o.declined_reason), '') AS reason,
      ${nameSelect} AS candidate
    FROM public.offers o
    JOIN public.applications a ON a.tenant_id = o.tenant_id AND a.id = o.application_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
    LEFT JOIN public.business_units b ON b.tenant_id = p.tenant_id AND b.id = p.business_unit_id
    ${nameJoin}
    WHERE ${dsql.join(clauses, dsql` AND `)}
    ORDER BY COALESCE(o.declined_at, o.updated_at) DESC
    LIMIT 100
  `);
  const raw = asRows<DeclinedSqlRow>(res);
  const rows = raw.map((r) => ({
    ...(deps.canSeeCandidateNames ? { candidate: r.candidate ?? "—" } : {}),
    role: r.role,
    business_unit: r.business_unit ?? "—",
    declined_on: isoDay(r.declined_on),
    reason: r.reason ?? "Not recorded",
  }));

  // Most common recorded reason (case-insensitive exact text), only when it repeats.
  const counts = new Map<string, { text: string; n: number }>();
  for (const r of raw) {
    if (!r.reason) continue;
    const k = r.reason.toLowerCase();
    const hit = counts.get(k) ?? { text: r.reason, n: 0 };
    hit.n += 1;
    counts.set(k, hit);
  }
  const common = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const unrecorded = raw.filter((r) => !r.reason).length;
  const summary =
    raw.length === 0
      ? `No offers were declined${scopePhrase(f)} in this period.`
      : `${plural(raw.length, "offer")} declined${scopePhrase(f)}.` +
        (common && common.n > 1 ? ` Most common reason: "${common.text}" (${common.n}).` : "") +
        (unrecorded > 0 ? ` ${unrecorded} without a recorded reason.` : "");

  return {
    title: "Declined offers",
    kind: "table",
    columns: [
      ...(deps.canSeeCandidateNames ? [col("candidate", "Candidate", "text")] : []),
      col("role", "Role", "text"),
      col("business_unit", "Business unit", "text"),
      col("declined_on", "Declined on", "date"),
      col("reason", "Reason given", "text"),
    ],
    rows,
    summary,
    footnote:
      "Source: offers. Reason = the decline reason recorded on the offer. Period = when the offer was declined. No candidate contact details are shown" +
      (deps.canSeeCandidateNames
        ? "."
        : "; candidate names are visible to HR and admin roles only.") +
      (raw.length === 100 ? " Showing the 100 most recent." : ""),
    empty: raw.length === 0,
  };
};

interface CaseRoleSqlRow {
  case_id: string;
  role: string;
  hiring_manager_id: string;
  requisition_id: string;
}

const joinersNext30Days: Executor = async (deps, f) => {
  const today = new Date();
  const in30 = new Date(today.getTime() + 30 * 86_400_000);
  const report = await getOnboardingReadinessReport(deps.db, deps.tenantId, {
    from: today.toISOString(),
    to: in30.toISOString(),
    businessUnitId: f.businessUnitId,
  });

  // The readiness report carries no role; look the titles up for exactly these cases.
  const caseIds = report.rows.map((r) => r.caseId);
  const roleById = new Map<string, CaseRoleSqlRow>();
  if (caseIds.length > 0) {
    const res = await deps.db.execute(dsql`
      SELECT
        oc.id::text AS case_id,
        p.title AS role,
        r.hiring_manager_id::text AS hiring_manager_id,
        r.id::text AS requisition_id
      FROM public.onboarding_cases oc
      JOIN public.applications a ON a.tenant_id = oc.tenant_id AND a.id = oc.application_id
      JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
      JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
      WHERE oc.tenant_id = ${deps.tenantId}::uuid
        AND oc.id::text IN (${dsql.join(
          caseIds.map((id) => dsql`${id}`),
          dsql`, `,
        )})
    `);
    for (const row of asRows<CaseRoleSqlRow>(res)) roleById.set(row.case_id, row);
  }

  const cases = report.rows.filter((r) => {
    if (!deps.hmMembershipId) return true;
    return roleById.get(r.caseId)?.hiring_manager_id === deps.hmMembershipId;
  });

  let ready = 0;
  const rows = cases.map((r) => {
    const missing: string[] = [];
    const openTasks = r.tasksTotal - r.tasksDone;
    if (openTasks > 0)
      missing.push(
        `${plural(openTasks, "task")} open${r.overdueTasks ? ` (${r.overdueTasks} overdue)` : ""}`,
      );
    const unverified = r.docsTotal - r.docsVerified;
    if (r.docsTotal === 0) missing.push("no documents uploaded");
    else if (unverified > 0) missing.push(`${plural(unverified, "document")} not verified`);
    if (r.bgvStatus === null) missing.push("background check not started");
    else if (r.bgvStatus !== "completed")
      missing.push(`background check ${humanize(r.bgvStatus).toLowerCase()}`);
    const itOpen = r.itTotal - r.itProvisioned;
    if (r.itTotal === 0) missing.push("no IT request");
    else if (itOpen > 0) missing.push(`${plural(itOpen, "IT item")} pending`);
    if (missing.length === 0) ready += 1;
    return {
      name: r.candidateName ?? "—",
      role: roleById.get(r.caseId)?.role ?? "—",
      start_date: r.expectedStartDate,
      days_to_start: r.daysToStart,
      outstanding: missing.length === 0 ? "Ready" : missing.join("; "),
    };
  });

  const summary =
    rows.length === 0
      ? `No one is due to join${scopePhrase(f)} in the next 30 days.`
      : `${plural(rows.length, "person", "people")} ${rows.length === 1 ? "is" : "are"} joining${scopePhrase(f)} in the next 30 days; ${ready} ${ready === 1 ? "is" : "are"} fully ready and ${rows.length - ready} still ${rows.length - ready === 1 ? "has" : "have"} items outstanding.`;

  return {
    title: "Joiners in the next 30 days",
    kind: "table",
    columns: [
      col("name", "Name", "text"),
      col("role", "Role", "text"),
      col("start_date", "Start date", "date"),
      col("days_to_start", "Days to start", "number"),
      col("outstanding", "Still outstanding", "text"),
    ],
    rows,
    summary,
    footnote:
      "Source: onboarding cases, tasks, documents, background checks and IT requests (Onboarding readiness report). Active cases with an expected start date from today to 30 days out. Ready = every task done, every uploaded document verified, background check completed and IT provisioned.",
    empty: rows.length === 0,
  };
};

interface PendingApprovalSqlRow {
  subject_type: string;
  title: string | null;
  requested_at: Date | string;
  days_waiting: number;
  current_step_index: number;
}

const pendingApprovals: Executor = async (deps) => {
  const analytics = await getApprovalAnalyticsReport(deps.db, deps.tenantId, {});
  const res = await deps.db.execute(dsql`
    SELECT
      ar.subject_type::text AS subject_type,
      COALESCE(rp.title, op.title) AS title,
      ar.requested_at AS requested_at,
      ROUND((EXTRACT(EPOCH FROM (now() - ar.requested_at)) / 86400.0)::numeric, 1)::float8
        AS days_waiting,
      ar.current_step_index AS current_step_index
    FROM public.approval_requests ar
    LEFT JOIN public.requisitions r
      ON ar.subject_type = 'requisition' AND r.tenant_id = ar.tenant_id AND r.id = ar.subject_id
    LEFT JOIN public.positions rp
      ON rp.tenant_id = r.tenant_id AND rp.id = r.position_id
    LEFT JOIN public.offers o
      ON ar.subject_type = 'offer' AND o.tenant_id = ar.tenant_id AND o.id = ar.subject_id
    LEFT JOIN public.applications oa
      ON oa.tenant_id = o.tenant_id AND oa.id = o.application_id
    LEFT JOIN public.requisitions orq
      ON orq.tenant_id = oa.tenant_id AND orq.id = oa.requisition_id
    LEFT JOIN public.positions op
      ON op.tenant_id = orq.tenant_id AND op.id = orq.position_id
    WHERE ar.tenant_id = ${deps.tenantId}::uuid
      AND ar.status = 'pending'
    ORDER BY ar.requested_at ASC
    LIMIT 50
  `);
  const raw = asRows<PendingApprovalSqlRow>(res);
  const rows = raw.map((r) => ({
    type: humanize(r.subject_type),
    item: r.title ?? "—",
    requested: isoDay(r.requested_at),
    step: r.current_step_index + 1,
    days_waiting: r.days_waiting,
  }));
  const pending = analytics.turnaround.pendingCount;
  const reqs = raw.filter((r) => r.subject_type === "requisition").length;
  const offers = raw.filter((r) => r.subject_type === "offer").length;
  const oldest = raw[0];
  const summary =
    pending === 0
      ? "Nothing is waiting for approval."
      : `${plural(pending, "approval")} pending (${reqs} requisition, ${offers} offer${raw.length > reqs + offers ? `, ${raw.length - reqs - offers} other` : ""}).` +
        (oldest
          ? ` The oldest, ${oldest.title ?? humanize(oldest.subject_type)}, has waited ${fmtDays(oldest.days_waiting)}.`
          : "") +
        (analytics.turnaround.medianHours !== null
          ? ` Decided approvals typically take ${round1(analytics.turnaround.medianHours / 24)} days.`
          : "");
  return {
    title: "Pending approvals",
    kind: "table",
    columns: [
      col("type", "Type", "text"),
      col("item", "For", "text"),
      col("requested", "Requested", "date"),
      col("step", "Approval step", "number"),
      col("days_waiting", "Days waiting", "days"),
    ],
    rows,
    summary,
    footnote:
      "Source: approval requests (Approval cycle report). Pending = not yet approved, rejected, cancelled or expired. Oldest first; up to 50 shown. Typical time = median from request to decision over all decided approvals.",
    empty: raw.length === 0,
  };
};

// ─────────────────────────────── partners & team ───────────────────────────────

const partnerPerformance: Executor = async (deps, f) => {
  const report = await getPartnerScorecardReport(deps.db, deps.tenantId, reportFilters(f));
  const rows = report.rows.map((r) => ({
    partner: r.orgName,
    submissions: r.submissions,
    shortlist_rate: r.shortlistRate,
    hires: r.hires,
    hire_rate: r.hireRate,
  }));
  const subs = report.rows.reduce((s, r) => s + r.submissions, 0);
  const hires = report.rows.reduce((s, r) => s + r.hires, 0);
  const leader = [...report.rows].sort(
    (a, b) => b.hires - a.hires || b.submissions - a.submissions,
  )[0];
  const summary =
    report.rows.length === 0
      ? "No recruitment partners are set up."
      : subs === 0
        ? `${plural(report.rows.length, "partner")}, but no submissions${scopePhrase(f)} in this period.`
        : `${plural(report.rows.length, "partner")} submitted ${plural(subs, "candidate")} and produced ${plural(hires, "hire")}${scopePhrase(f)}.` +
          (leader
            ? hires > 0
              ? ` ${leader.orgName} leads with ${plural(leader.hires, "hire")} from ${leader.submissions} submissions.`
              : ` ${leader.orgName} submitted the most (${leader.submissions}).`
            : "");
  return {
    title: "Recruitment partner performance",
    kind: "bar",
    columns: [
      col("partner", "Partner", "text"),
      col("submissions", "Submissions", "number"),
      col("shortlist_rate", "Shortlist rate", "percent"),
      col("hires", "Hires", "number"),
      col("hire_rate", "Hire rate", "percent"),
    ],
    rows,
    chart: { x: "partner", y: ["submissions", "hires"] },
    summary,
    footnote:
      "Source: partner submissions (Partner / agency scorecard). Shortlist rate = share of submissions that ever reached Shortlisted or beyond; hire rate = hires ÷ submissions. Period = when the candidate was submitted.",
    empty: report.rows.length === 0,
  };
};

const recruiterActivity: Executor = async (deps, f) => {
  const report = await getRecruiterProductivityReport(deps.db, deps.tenantId, {
    from: f.window.from,
    to: f.window.to,
    businessUnitId: f.businessUnitId,
  });
  const names = await deps.resolveNames(report.rows.map((r) => r.recruiterMembershipId));
  const rows = report.rows.map((r) => ({
    recruiter: names.get(r.recruiterMembershipId) ?? "Unknown recruiter",
    reqs_owned: r.reqsOwned,
    candidates: r.applications,
    interviews: r.interviewsScheduled,
    offers: r.offersExtended,
    hires: r.hires,
  }));
  const sum = (k: "candidates" | "interviews" | "offers" | "hires") =>
    rows.reduce((s, r) => s + r[k], 0);
  const top = [...rows].sort(
    (a, b) => b.interviews + b.offers + b.hires - (a.interviews + a.offers + a.hires),
  )[0];
  const summary =
    rows.length === 0
      ? `No recruiter activity${scopePhrase(f)} in this period.`
      : `${plural(rows.length, "recruiter")} handled ${plural(sum("candidates"), "candidate")}${scopePhrase(f)}, moving them forward with ${plural(sum("interviews"), "interview")} booked, ${plural(sum("offers"), "offer")} extended and ${plural(sum("hires"), "hire")}.` +
        (top && top.interviews + top.offers + top.hires > 0
          ? ` ${top.recruiter} moved the most forward.`
          : "");
  return {
    title: "Recruiter activity",
    kind: "bar",
    columns: [
      col("recruiter", "Recruiter", "text"),
      col("reqs_owned", "Requisitions owned", "number"),
      col("candidates", "Candidates handled", "number"),
      col("interviews", "Interviews booked", "number"),
      col("offers", "Offers extended", "number"),
      col("hires", "Hires", "number"),
    ],
    rows,
    chart: { x: "recruiter", y: ["interviews", "offers", "hires"] },
    summary,
    footnote:
      "Source: requisitions, applications, interviews and offers (Recruiter productivity report). 'Moved forward' = interviews booked, offers extended and hires on the candidates assigned to each recruiter. Period = when the application (or requisition, for ownership) was created.",
    empty: rows.length === 0,
  };
};

// ─────────────────────────────── dispatch ───────────────────────────────

const EXECUTORS: Record<AskDataIntentId, Executor> = {
  open_reqs_by_bu: openReqsByBu,
  oldest_open_reqs: oldestOpenReqs,
  time_to_fill: timeToFill,
  time_to_fill_trend: timeToFillTrend,
  hires_by_source: hiresBySource,
  partner_performance: partnerPerformance,
  pipeline_funnel: pipelineFunnel,
  stage_bottlenecks: stageBottlenecks,
  offer_acceptance: offerAcceptance,
  declined_offers: declinedOffers,
  joiners_next_30_days: joinersNext30Days,
  pending_feedback: pendingFeedback,
  pending_approvals: pendingApprovals,
  recruiter_activity: recruiterActivity,
};

/**
 * Run one intent. Measures share the single tenant-transaction connection, so
 * executors await sequentially (never Promise.all) — the catalog's rule.
 */
export function executeAskDataIntent(
  intent: AskDataIntentId,
  deps: AskDataExecDeps,
  filters: ResolvedAskDataFilters,
): Promise<AskDataResult> {
  return EXECUTORS[intent](deps, filters);
}
