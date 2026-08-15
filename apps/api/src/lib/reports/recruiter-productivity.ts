/**
 * Catalog report #5 — RECRUITER PRODUCTIVITY (R0.2).
 *
 * "What did each recruiter actually move this period?" — reqs owned,
 * applications worked, interviews booked, offers extended, hires. The
 * second of the two genuinely-new P0 reports (build plan §2.2).
 *
 * THE DEFINITION THAT MATTERS — attribution runs on TWO different keys,
 * and the report is only honest if both are stated:
 *   - `reqsOwned` = requisitions whose `primary_recruiter_id` is this
 *     membership. Ownership is a property of the REQUISITION, so this
 *     column is bounded by the REQUISITION-created window and cannot be
 *     narrowed by application-axis filters (source, stage, requisition).
 *   - `applications` / `interviewsScheduled` / `offersExtended` / `hires`
 *     = work on applications whose `assigned_recruiter_membership_id` is
 *     this membership, bounded by the APPLICATION-created window and
 *     narrowed by every application-axis filter.
 * The asymmetry is deliberate: filtering to `source = referral` should
 * cut a recruiter's referral submissions without pretending they own
 * fewer requisitions. Applications with no assigned recruiter are
 * attributed to nobody and simply do not appear.
 *
 * `hires` is the platform-wide definition (applications now at stage
 * `offer_accepted`), the same one applicationTotals / sourceMix use — NOT
 * "offers with status accepted", so a recruiter's hire count reconciles
 * with every other surface.
 *
 * House conventions inherited from R0.1: request-time raw SQL inside the
 * tenant transaction, explicit tenant predicates on top of RLS, ISO +
 * `::timestamptz` bounds, aggregation in Postgres and assembly in JS.
 * The four measures are separate queries rather than one join: joining
 * interviews AND offers to applications in a single statement fans out
 * and would multiply the counts.
 *
 * Recruiter DISPLAY NAMES are attached by the router via the service-role
 * connection — `public.users` is self-only under RLS, so a name join on
 * the tenant-bound db would return nulls for everyone but the caller.
 */

import { sql as dsql } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import type { ReportFilters, RecruiterProductivityRow } from "@hireops/api-types";

import { buildApplicationScope, buildRequisitionScope } from "./dimensions";

/** The report row minus the display name the router attaches. */
export type RecruiterProductivityRowBase = Omit<RecruiterProductivityRow, "recruiterName">;

export interface RecruiterProductivityReport {
  rows: RecruiterProductivityRowBase[];
}

/** postgres-js returns `{rows: …}`; fall back to the array form (matches measures.ts). */
function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

interface CountRow {
  membership_id: string;
  count: number;
}
interface ApplicationCountRow {
  membership_id: string;
  applications: number;
  hires: number;
}

/**
 * DEFINITION — recruiter productivity: one row per recruiter membership
 * that either owns a requisition or is assigned an application in scope,
 * carrying the five counts above, busiest first (applications desc, then
 * reqs owned desc, then membership id for a stable order).
 */
export async function getRecruiterProductivityReport(
  db: TenantBoundDb,
  tenantId: string,
  filters: ReportFilters = {},
): Promise<RecruiterProductivityReport> {
  const reqScope = buildRequisitionScope(tenantId, filters);
  const appScope = buildApplicationScope(tenantId, filters);

  // 1. Ownership — the requisition axis.
  const reqRes = await db.execute(dsql`
    SELECT r.primary_recruiter_id::text AS membership_id, COUNT(*)::int AS count
    FROM public.requisitions r
    ${reqScope.join}
    WHERE ${reqScope.where}
    GROUP BY r.primary_recruiter_id
  `);

  // 2. Applications + hires — one pass, two aggregates.
  const appRes = await db.execute(dsql`
    SELECT
      a.assigned_recruiter_membership_id::text AS membership_id,
      COUNT(*)::int AS applications,
      COUNT(*) FILTER (WHERE a.current_stage = 'offer_accepted')::int AS hires
    FROM public.applications a
    ${appScope.join}
    WHERE ${appScope.where}
      AND a.assigned_recruiter_membership_id IS NOT NULL
    GROUP BY a.assigned_recruiter_membership_id
  `);

  // 3. Interviews booked on those applications, any status — the report
  // measures scheduling effort, and `interviews` has no completed_at to
  // measure anything finer (build plan §2.3, migration deferred to R1.2).
  const interviewRes = await db.execute(dsql`
    SELECT a.assigned_recruiter_membership_id::text AS membership_id, COUNT(*)::int AS count
    FROM public.interviews i
    JOIN public.applications a
      ON a.tenant_id = i.tenant_id AND a.id = i.application_id
    ${appScope.join}
    WHERE i.tenant_id = ${tenantId}::uuid
      AND ${appScope.where}
      AND a.assigned_recruiter_membership_id IS NOT NULL
    GROUP BY a.assigned_recruiter_membership_id
  `);

  // 4. Offers that actually went OUT (extended_at stamped) — a drafted
  // offer is not productivity.
  const offerRes = await db.execute(dsql`
    SELECT a.assigned_recruiter_membership_id::text AS membership_id, COUNT(*)::int AS count
    FROM public.offers o
    JOIN public.applications a
      ON a.tenant_id = o.tenant_id AND a.id = o.application_id
    ${appScope.join}
    WHERE o.tenant_id = ${tenantId}::uuid
      AND o.extended_at IS NOT NULL
      AND ${appScope.where}
      AND a.assigned_recruiter_membership_id IS NOT NULL
    GROUP BY a.assigned_recruiter_membership_id
  `);

  const reqsOwned = new Map(asRows<CountRow>(reqRes).map((r) => [r.membership_id, r.count]));
  const apps = new Map(asRows<ApplicationCountRow>(appRes).map((r) => [r.membership_id, r]));
  const interviews = new Map(asRows<CountRow>(interviewRes).map((r) => [r.membership_id, r.count]));
  const offers = new Map(asRows<CountRow>(offerRes).map((r) => [r.membership_id, r.count]));

  // Either axis is enough to earn a row: a recruiter who owns reqs but
  // has had nothing assigned yet is a real (and interesting) zero row.
  const membershipIds = [...new Set([...reqsOwned.keys(), ...apps.keys()])];

  const rows: RecruiterProductivityRowBase[] = membershipIds
    .map((membershipId) => {
      const app = apps.get(membershipId);
      return {
        recruiterMembershipId: membershipId,
        reqsOwned: reqsOwned.get(membershipId) ?? 0,
        applications: app?.applications ?? 0,
        interviewsScheduled: interviews.get(membershipId) ?? 0,
        offersExtended: offers.get(membershipId) ?? 0,
        hires: app?.hires ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.applications - a.applications ||
        b.reqsOwned - a.reqsOwned ||
        a.recruiterMembershipId.localeCompare(b.recruiterMembershipId),
    );

  return { rows };
}
