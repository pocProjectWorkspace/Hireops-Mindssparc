/**
 * PC-6 — read helpers for evidence-based CV screening.
 *
 * The evidence itself is produced by the ai-score drain (apps/workers) and
 * stored in `application_screening_evidence` (migration 0124). These helpers
 * shape it for the list / detail procedures and hold the two pieces of read
 * policy the router applies everywhere:
 *
 *   - ORDER: `evidenceOrderSql()` is the SQL mirror of @hireops/ai-scoring
 *     `compareScreeningSummaries` — met (partially met = ½) DESC, then not met
 *     ASC, unscreened last. `met*2 + partial` keeps it integer arithmetic.
 *   - SCORE HIDING (NEW-16): when the tenant hides the screening score
 *     (`aiSettings.screeningScoreVisible = false`) the 0–100 `aiScore` is
 *     OMITTED from the output (not nulled — null means "unscored") and the
 *     0–1 factor sub-scores are stripped from the explanation; the written
 *     factor notes stay.
 */

import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import {
  aiScoreOutbox,
  applications,
  applicationScreeningEvidence,
  type TenantBoundDb,
} from "@hireops/db";
import type {
  ScreeningCriterionEvidenceView,
  ScreeningEvidenceStatus,
  ScreeningEvidenceSummary,
  ScreeningEvidenceView,
  ScreeningQueue,
} from "@hireops/api-types";

/** Columns to add to a select that LEFT JOINs application_screening_evidence. */
export const screeningSummaryColumns = {
  screeningStatus: applicationScreeningEvidence.status,
  screeningCriteriaCount: applicationScreeningEvidence.criteriaCount,
  screeningMet: applicationScreeningEvidence.metCount,
  screeningPartiallyMet: applicationScreeningEvidence.partiallyMetCount,
  screeningNotMet: applicationScreeningEvidence.notMetCount,
  screeningUnclear: applicationScreeningEvidence.unclearCount,
};

export interface ScreeningSummaryCols {
  screeningStatus: string | null;
  screeningCriteriaCount: number | null;
  screeningMet: number | null;
  screeningPartiallyMet: number | null;
  screeningNotMet: number | null;
  screeningUnclear: number | null;
}

/** The LEFT JOIN predicate (tenant + application). */
export function screeningEvidenceJoin() {
  return and(
    eq(applicationScreeningEvidence.tenantId, applications.tenantId),
    eq(applicationScreeningEvidence.applicationId, applications.id),
  );
}

function narrowStatus(s: string): ScreeningEvidenceStatus {
  return s === "stale" ? "stale" : "done";
}

export function toScreeningSummary(r: ScreeningSummaryCols): ScreeningEvidenceSummary | null {
  if (r.screeningStatus === null) return null;
  return {
    status: narrowStatus(r.screeningStatus),
    criteriaCount: r.screeningCriteriaCount ?? 0,
    met: r.screeningMet ?? 0,
    partiallyMet: r.screeningPartiallyMet ?? 0,
    notMet: r.screeningNotMet ?? 0,
    unclear: r.screeningUnclear ?? 0,
  };
}

/** ORDER BY fragment: the deterministic evidence key, unscreened rows last. */
export function evidenceOrderSql() {
  return dsql`(${applicationScreeningEvidence.metCount} * 2 + ${applicationScreeningEvidence.partiallyMetCount}) DESC NULLS LAST, ${applicationScreeningEvidence.notMetCount} ASC NULLS LAST`;
}

function narrowCriteria(value: unknown): ScreeningCriterionEvidenceView[] {
  if (!Array.isArray(value)) return [];
  const out: ScreeningCriterionEvidenceView[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const verdict = c.verdict;
    if (
      typeof c.key !== "string" ||
      typeof c.label !== "string" ||
      (verdict !== "met" &&
        verdict !== "partially_met" &&
        verdict !== "not_met" &&
        verdict !== "unclear")
    ) {
      continue;
    }
    out.push({
      key: c.key,
      kind: c.kind === "requirement" ? "requirement" : "must_have",
      label: c.label,
      verdict,
      reason: typeof c.reason === "string" ? c.reason : "",
      quotes: Array.isArray(c.quotes)
        ? c.quotes.filter((q): q is string => typeof q === "string")
        : [],
    });
  }
  return out;
}

/** Full evidence for ONE application (RLS-scoped db), or null when unscreened. */
export async function loadScreeningEvidence(
  db: TenantBoundDb,
  applicationId: string,
): Promise<ScreeningEvidenceView | null> {
  const [row] = await db
    .select()
    .from(applicationScreeningEvidence)
    .where(eq(applicationScreeningEvidence.applicationId, applicationId))
    .limit(1);
  if (!row) return null;
  return {
    status: narrowStatus(row.status),
    criteriaCount: row.criteriaCount,
    met: row.metCount,
    partiallyMet: row.partiallyMetCount,
    notMet: row.notMetCount,
    unclear: row.unclearCount,
    criteria: narrowCriteria(row.criteria),
    quotesDropped: row.quotesDropped,
    model: row.model,
    promptVersion: row.promptVersion,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/**
 * PC-4 — scoring queue depth per requisition: `total` = applications ever
 * queued for screening, `pending` = still waiting or in flight.
 */
export async function loadScreeningQueueByRequisition(
  db: TenantBoundDb,
  requisitionIds: string[],
): Promise<Map<string, ScreeningQueue>> {
  const out = new Map<string, ScreeningQueue>();
  const ids = [...new Set(requisitionIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      requisitionId: applications.requisitionId,
      total: dsql<number>`count(*)::int`,
      pending: dsql<number>`count(*) FILTER (WHERE ${aiScoreOutbox.status} IN ('pending', 'processing'))::int`,
    })
    .from(aiScoreOutbox)
    .innerJoin(
      applications,
      and(
        eq(applications.tenantId, aiScoreOutbox.tenantId),
        eq(applications.id, aiScoreOutbox.applicationId),
      ),
    )
    .where(inArray(applications.requisitionId, ids))
    .groupBy(applications.requisitionId);
  for (const r of rows) {
    out.set(r.requisitionId, { total: Number(r.total), pending: Number(r.pending) });
  }
  return out;
}

/**
 * The score explanation as presented: unchanged when the score is visible;
 * with every numeric factor sub-score removed when it is hidden.
 */
export function presentScoreExplanation(explanation: unknown, scoreVisible: boolean): unknown {
  if (scoreVisible || !explanation || typeof explanation !== "object") return explanation ?? null;
  const exp = { ...(explanation as Record<string, unknown>) };
  if (Array.isArray(exp.top_factors)) {
    exp.top_factors = exp.top_factors.map((f: unknown) => {
      if (!f || typeof f !== "object") return f;
      const rest = { ...(f as Record<string, unknown>) };
      delete rest.score;
      return rest;
    });
  }
  return exp;
}

/** `{ aiScore }` when visible, `{}` when hidden — spread into an output row. */
export function presentAiScore(
  aiScore: string | number | null,
  scoreVisible: boolean,
): { aiScore?: number | null } {
  if (!scoreVisible) return {};
  return { aiScore: aiScore === null ? null : Number(aiScore) };
}
