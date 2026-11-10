/**
 * PC-5 — triage at volume: the SQL half of the candidate-list filters.
 *
 * One builder for every consumer that has to agree on "which applications
 * match": listCandidatesByRequisition (the paged candidates-by-role list),
 * listCandidates (triage Hot Zone / Momentum), and bulkMoveApplications'
 * "select all N matching" mode. Everything is a SQL predicate — nothing is
 * filtered in JS after the page is fetched, so paging and totals stay honest.
 *
 * Every predicate here references applications, candidates and persons ONLY,
 * so a query that uses them must join those three tables (all the list queries
 * do). Requisition / position joins are for display and are not required.
 */

import { and, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { applications, candidates, persons } from "@hireops/db";
import type {
  ApplicationFactFilters,
  CandidateListFilter,
  CandidateListSort,
} from "@hireops/api-types";
import { canSeeScreeningComp } from "./screening-answers";

/** Escape LIKE / ILIKE metacharacters so user text matches literally. */
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The effective notice period in days — the application's stated answer, else
 * the parsed CV's (top-level, then personal.*), mirroring parsedCvNoticeDays +
 * presentScreeningAnswers. Non-numeric / negative CV values are ignored.
 */
export const effectiveNoticeDaysSql: SQL<number | null> = sql<number | null>`COALESCE(
  ${applications.noticePeriodDays}::numeric,
  CASE WHEN jsonb_typeof(${candidates.parsedSkills} -> 'notice_period_days') = 'number'
        AND (${candidates.parsedSkills} ->> 'notice_period_days')::numeric >= 0
       THEN round((${candidates.parsedSkills} ->> 'notice_period_days')::numeric) END,
  CASE WHEN jsonb_typeof(${candidates.parsedSkills} -> 'personal' -> 'notice_period_days') = 'number'
        AND (${candidates.parsedSkills} -> 'personal' ->> 'notice_period_days')::numeric >= 0
       THEN round((${candidates.parsedSkills} -> 'personal' ->> 'notice_period_days')::numeric) END
)`;

/**
 * The location a recruiter would read for "current location": the application's
 * answer (PC-7) when present, else the person record's city / country.
 */
export const effectiveLocationSql: SQL<string> = sql<string>`COALESCE(
  NULLIF(btrim(${applications.currentLocation}), ''),
  concat_ws(', ', ${persons.locationCity}, ${persons.locationCountry})
)`;

/** The recruiter ref code (C-XXXXXX) in SQL — must equal recruiterRefCode(). */
const refCodeSql = sql`('C-' || upper(substr(replace(${candidates.id}::text, '-', ''), 1, 6)))`;

export interface FactFilterResolution {
  /** The filters that will actually be applied. */
  applied: ApplicationFactFilters;
  /** True when an expected-CTC filter was supplied but dropped (pay not visible). */
  compFilterIgnored: boolean;
}

/**
 * Drop the expected-CTC filter for callers who cannot see pay — silently, so a
 * hiring manager can't binary-search a candidate's expected CTC via counts.
 */
export function resolveFactFilters(
  filters: ApplicationFactFilters,
  roles: readonly string[],
): FactFilterResolution {
  if (filters.maxExpectedSalaryInrPaise === undefined || canSeeScreeningComp(roles)) {
    return { applied: { ...filters }, compFilterIgnored: false };
  }
  const applied: ApplicationFactFilters = { ...filters };
  delete applied.maxExpectedSalaryInrPaise;
  return { applied, compFilterIgnored: true };
}

/** SQL predicates for the PC-7 fact filters (already comp-resolved). */
export function factFilterConditions(f: ApplicationFactFilters): SQL[] {
  const out: SQL[] = [];
  if (f.knockout === "pass") out.push(eq(applications.knockoutPassed, true));
  else if (f.knockout === "fail") out.push(eq(applications.knockoutPassed, false));
  else if (f.knockout === "unknown") out.push(isNull(applications.knockoutPassed));

  if (f.maxNoticeDays !== undefined) {
    // An unknown notice is NULL and drops out — unknown is not "≤ N".
    out.push(sql`${effectiveNoticeDaysSql} <= ${f.maxNoticeDays}`);
  }
  if (f.maxExpectedSalaryInrPaise !== undefined) {
    out.push(
      sql`${applications.expectedSalaryInrPaise} <= ${String(Math.round(f.maxExpectedSalaryInrPaise))}::bigint`,
    );
  }
  const loc = f.locationContains?.trim();
  if (loc) {
    out.push(sql`${effectiveLocationSql} ILIKE ${`%${escapeLike(loc)}%`}`);
  }
  if (f.hasPartner !== undefined) {
    const partnerish = sql`(${isNotNull(applications.sourcePartnerId)} OR ${applications.source} IN ('partner_empanelled', 'partner_adhoc'))`;
    out.push(f.hasPartner ? partnerish : sql`NOT (${partnerish})`);
  }
  return out;
}

/** Name / ref-code search (case-insensitive substring, like the old JS filter). */
export function searchCondition(search: string | undefined): SQL | null {
  const q = search?.trim();
  if (!q) return null;
  const pattern = `%${escapeLike(q)}%`;
  return sql`(${persons.fullName} ILIKE ${pattern} OR ${refCodeSql} ILIKE ${pattern})`;
}

/**
 * Every predicate of a candidate-list filter. `includeRequisition: false` drops
 * the requisition predicate (the role-picker facet counts across roles).
 */
export function candidateListConditions(
  filter: CandidateListFilter,
  roles: readonly string[],
  opts: { includeRequisition?: boolean } = {},
): { conditions: SQL[]; compFilterIgnored: boolean } {
  const { search, stage, source, requisitionId, ...facts } = filter;
  const { applied, compFilterIgnored } = resolveFactFilters(facts, roles);
  const conditions: SQL[] = [];
  if (requisitionId && opts.includeRequisition !== false) {
    conditions.push(eq(applications.requisitionId, requisitionId));
  }
  if (stage) conditions.push(eq(applications.currentStage, stage));
  if (source) conditions.push(eq(applications.source, source));
  const s = searchCondition(search);
  if (s) conditions.push(s);
  conditions.push(...factFilterConditions(applied));
  return { conditions, compFilterIgnored };
}

/** AND the conditions, or undefined for none (drizzle's "no WHERE"). */
export function whereAll(conditions: SQL[]): SQL | undefined {
  return conditions.length ? and(...conditions) : undefined;
}

/**
 * ORDER BY fragments per sort key. Every order ends on applications.id so
 * offset paging is stable across requests.
 *
 * PC-6 HOOK: add the evidence ordering here, keyed by the new
 * candidateListSortSchema value (packages/api-types/src/candidate-list.ts).
 */
export const CANDIDATE_LIST_SORT_ORDER: Record<CandidateListSort, SQL[]> = {
  ai_score: [
    sql`${applications.aiScore} DESC NULLS LAST`,
    desc(applications.createdAt),
    desc(applications.id),
  ],
  newest: [desc(applications.createdAt), desc(applications.id)],
};
