/**
 * PC-7 — per-application screening answers (notice period, current / expected
 * CTC, current location) and the knockout re-evaluation that follows a write.
 *
 * ONE write path for every capture channel:
 *   - public apply form      → source 'candidate'   (router submitApplication)
 *   - partner submit form    → source 'partner'     (router ingestPartnerApplication)
 *   - recruiter edit         → source 'recruiter'   (router updateApplicationScreeningAnswers)
 *   - Workday import / bulk CV upload (other tickets) → call
 *     `setApplicationScreeningAnswers(db, { …, source: 'import' })`
 *
 * Insert-time paths (apply, partner) use the PURE half —
 * `resolveScreeningAnswersForInsert` + `screeningKnockoutView` — so the columns
 * and the knockout verdict land atomically with the application insert.
 * Post-insert writers use `setApplicationScreeningAnswers`, which writes the
 * columns AND re-evaluates the requisition's knockouts against the new values.
 *
 * Money: INR paise (minor units) in storage and on the wire, exactly like
 * applications.expected_salary_inr_paise (which IS the expected-CTC column).
 * The knockout view exposes CTC in MAJOR units per year because that is what
 * the wizard stores as the threshold.
 *
 * Visibility: CTC is pay data. Readers outside SCREENING_COMP_READ_ROLES get
 * both CTC values nulled (`compVisible: false`) — see presentScreeningAnswers.
 */

import { and, eq } from "drizzle-orm";
import {
  applications,
  candidates,
  requisitionKnockouts,
  type Database,
  type TenantBoundDb,
} from "@hireops/db";
import {
  evaluateKnockouts,
  type KnockoutEvaluation,
  type KnockoutInput,
  type ScreeningAnswersView,
} from "@hireops/ai-scoring";
import {
  SCREENING_KNOCKOUT_FIELD_PATHS,
  type ApplicationScreeningAnswers,
  type KnockoutSummary,
  type ScreeningAnswersInput,
  type ScreeningAnswersSource,
} from "@hireops/api-types";

/** Either the service pool (public apply) or a tenant-bound tx (everything else). */
export type ScreeningDb = Database | TenantBoundDb;

// ─────────────────────────── role gate ───────────────────────────

/**
 * Who may SEE (and therefore write) a candidate's current / expected CTC.
 * Reuses the existing comp gates: the comp desk (admin, hr_ops — HROPS-02
 * COMP_DESK_ROLES), the out-of-band offer approver (hr_head —
 * OFFER_APPROVAL_DECIDE_ROLES), and the recruiter, who drafts offers from the
 * triage drawer today and already sees expected salary on the comp-desk feed.
 * hiring_manager / panel_member / people_ops do not see candidate pay.
 */
export const SCREENING_COMP_READ_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "hr_ops",
  "hr_head",
  "recruiter",
]);

/** Who may edit screening answers on the candidate detail (recruiter edit path). */
export const SCREENING_ANSWERS_WRITE_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "recruiter",
  "hr_ops",
]);

export function canSeeScreeningComp(roles: readonly string[]): boolean {
  return roles.some((r) => SCREENING_COMP_READ_ROLES.has(r));
}

// ─────────────────────────── stored shape ───────────────────────────

/** The application columns this module owns (drizzle select shape). */
export interface StoredScreeningAnswers {
  noticePeriodDays: number | null;
  currentSalaryInrPaise: bigint | null;
  expectedSalaryInrPaise: bigint | null;
  currentLocation: string | null;
  screeningAnswersSource: string | null;
  screeningAnswersUpdatedAt: Date | null;
}

/** Drizzle select map for StoredScreeningAnswers — spread into a .select({...}). */
export const screeningAnswerColumns = {
  noticePeriodDays: applications.noticePeriodDays,
  currentSalaryInrPaise: applications.currentSalaryInrPaise,
  expectedSalaryInrPaise: applications.expectedSalaryInrPaise,
  currentLocation: applications.currentLocation,
  screeningAnswersSource: applications.screeningAnswersSource,
  screeningAnswersUpdatedAt: applications.screeningAnswersUpdatedAt,
} as const;

/** The parsed CV's notice period, if it carries one (top-level or personal.*). */
export function parsedCvNoticeDays(parsedCv: unknown): number | null {
  if (!parsedCv || typeof parsedCv !== "object") return null;
  const p = parsedCv as Record<string, unknown>;
  const top = p.notice_period_days;
  if (typeof top === "number" && Number.isFinite(top) && top >= 0) return Math.round(top);
  const personal = p.personal;
  if (personal && typeof personal === "object") {
    const n = (personal as Record<string, unknown>).notice_period_days;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

function cleanLocation(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function toBigintOrNull(v: number | null | undefined): bigint | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return BigInt(Math.round(v));
}

function hasAnySupplied(a: ScreeningAnswersInput | undefined): boolean {
  if (!a) return false;
  return (
    a.noticePeriodDays != null ||
    a.currentSalaryInrPaise != null ||
    a.expectedSalaryInrPaise != null ||
    (a.currentLocation != null && a.currentLocation.trim().length > 0)
  );
}

// ─────────────────────────── pure: insert-time ───────────────────────────

/** Column values for an applications INSERT (drizzle field names). */
export interface ScreeningInsertColumns {
  noticePeriodDays: number | null;
  currentSalaryInrPaise: bigint | null;
  expectedSalaryInrPaise: bigint | null;
  currentLocation: string | null;
  screeningAnswersSource: ScreeningAnswersSource | null;
  screeningAnswersUpdatedAt: Date | null;
}

/**
 * Resolve what a NEW application row stores, given what the submitter supplied
 * and the parsed CV. Notice period is pre-filled from the CV when the submitter
 * left it blank. Provenance (one value per row — the column is the LAST writer):
 *   - submitter supplied anything → the submitter's source
 *   - only the CV notice pre-fill → 'parsed_cv'
 *   - nothing at all → null
 */
export function resolveScreeningAnswersForInsert(args: {
  supplied: ScreeningAnswersInput | undefined;
  parsedCv: unknown;
  source: ScreeningAnswersSource;
  now?: Date;
}): ScreeningInsertColumns {
  const s = args.supplied ?? {};
  const cvNotice = parsedCvNoticeDays(args.parsedCv);
  const notice = s.noticePeriodDays ?? cvNotice;
  const suppliedAny = hasAnySupplied(args.supplied);
  const source: ScreeningAnswersSource | null = suppliedAny
    ? args.source
    : cvNotice != null
      ? "parsed_cv"
      : null;
  return {
    noticePeriodDays: notice ?? null,
    currentSalaryInrPaise: toBigintOrNull(s.currentSalaryInrPaise) ?? null,
    expectedSalaryInrPaise: toBigintOrNull(s.expectedSalaryInrPaise) ?? null,
    currentLocation: cleanLocation(s.currentLocation) ?? null,
    screeningAnswersSource: source,
    screeningAnswersUpdatedAt: source ? (args.now ?? new Date()) : null,
  };
}

/**
 * The flat view evaluateKnockouts reads for candidate/partner-asserted
 * knockouts, keyed by the catalogue field paths. CTC in MAJOR units. Notice
 * falls back to the parsed CV inside the evaluator (fallback_field_path), so
 * only the stored value is placed here.
 */
export function screeningKnockoutView(
  a: Pick<
    StoredScreeningAnswers,
    "noticePeriodDays" | "expectedSalaryInrPaise" | "currentLocation"
  >,
): ScreeningAnswersView {
  return {
    [SCREENING_KNOCKOUT_FIELD_PATHS.noticePeriodDays]: a.noticePeriodDays,
    [SCREENING_KNOCKOUT_FIELD_PATHS.expectedCtc]:
      a.expectedSalaryInrPaise != null ? Number(a.expectedSalaryInrPaise) / 100 : null,
    [SCREENING_KNOCKOUT_FIELD_PATHS.currentLocation]: a.currentLocation,
  };
}

// ─────────────────────────── pure: read-side ───────────────────────────

const SOURCES = new Set<string>(["candidate", "recruiter", "partner", "import", "parsed_cv"]);

/**
 * Shape stored answers for the wire. Notice falls back to the parsed CV (and
 * says so); CTC is nulled for callers outside SCREENING_COMP_READ_ROLES.
 */
export function presentScreeningAnswers(
  stored: StoredScreeningAnswers,
  parsedCv: unknown,
  roles: readonly string[],
): ApplicationScreeningAnswers {
  const compVisible = canSeeScreeningComp(roles);
  const cvNotice = stored.noticePeriodDays == null ? parsedCvNoticeDays(parsedCv) : null;
  const noticePeriodDays = stored.noticePeriodDays ?? cvNotice;
  return {
    noticePeriodDays,
    noticePeriodFrom:
      stored.noticePeriodDays != null ? "application" : cvNotice != null ? "parsed_cv" : null,
    currentSalaryInrPaise:
      compVisible && stored.currentSalaryInrPaise != null
        ? Number(stored.currentSalaryInrPaise)
        : null,
    expectedSalaryInrPaise:
      compVisible && stored.expectedSalaryInrPaise != null
        ? Number(stored.expectedSalaryInrPaise)
        : null,
    currentLocation: stored.currentLocation,
    source:
      stored.screeningAnswersSource && SOURCES.has(stored.screeningAnswersSource)
        ? (stored.screeningAnswersSource as ScreeningAnswersSource)
        : null,
    updatedAt: stored.screeningAnswersUpdatedAt
      ? stored.screeningAnswersUpdatedAt.toISOString()
      : null,
    compVisible,
  };
}

/**
 * Compact knockout verdict from applications.knockout_passed / knockout_failures
 * (the evaluator's failure entries). Actual values are deliberately dropped.
 */
export function summariseKnockouts(
  passed: boolean | null,
  failures: unknown,
  evaluatedAt: Date | null,
): KnockoutSummary {
  const items: KnockoutSummary["items"] = [];
  if (Array.isArray(failures)) {
    for (const f of failures) {
      if (!f || typeof f !== "object") continue;
      const e = f as Record<string, unknown>;
      items.push({
        knockoutId: typeof e.knockout_id === "string" ? e.knockout_id : "",
        fieldPath: typeof e.field_path === "string" ? e.field_path : null,
        label: typeof e.question_text === "string" ? e.question_text : null,
        result: e.result === false ? "fail" : "unknown",
        reason: typeof e.reason === "string" ? e.reason : "unknown",
      });
    }
  }
  return {
    passed,
    failCount: items.filter((i) => i.result === "fail").length,
    unknownCount: items.filter((i) => i.result === "unknown").length,
    evaluatedAt: evaluatedAt ? evaluatedAt.toISOString() : null,
    items,
  };
}

// ─────────────────────────── DB helpers ───────────────────────────

/** A requisition's knockouts as evaluator inputs, in the recruiter's order. */
export async function loadRequisitionKnockoutInputs(
  db: ScreeningDb,
  tenantId: string,
  requisitionId: string,
): Promise<KnockoutInput[]> {
  const rows = await db
    .select({
      id: requisitionKnockouts.id,
      type: requisitionKnockouts.type,
      source: requisitionKnockouts.source,
      questionText: requisitionKnockouts.questionText,
      thresholdValue: requisitionKnockouts.thresholdValue,
    })
    .from(requisitionKnockouts)
    .where(
      and(
        eq(requisitionKnockouts.tenantId, tenantId),
        eq(requisitionKnockouts.requisitionId, requisitionId),
      ),
    )
    .orderBy(requisitionKnockouts.orderIndex);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    source: r.source,
    questionText: r.questionText,
    thresholdValue: r.thresholdValue,
  }));
}

export interface SetApplicationScreeningAnswersArgs {
  tenantId: string;
  applicationId: string;
  /**
   * Patch semantics: an omitted key is left unchanged; `null` clears it.
   * Values are validated by screeningAnswersInputSchema at the API edge —
   * non-tRPC callers (import / bulk upload) should parse with it too.
   */
  answers: ScreeningAnswersInput;
  source: ScreeningAnswersSource;
  /** Re-run the requisition's knockouts against the new values (default true). */
  reevaluateKnockouts?: boolean;
  now?: Date;
}

export interface SetApplicationScreeningAnswersResult {
  stored: StoredScreeningAnswers;
  /** The re-evaluation, or null when skipped / the application wasn't found. */
  knockout: KnockoutEvaluation | null;
  knockoutEvaluatedAt: Date | null;
  parsedCv: unknown;
}

/**
 * THE shared server write for screening answers (recruiter edit, Workday
 * import, bulk CV upload). Writes the supplied columns + provenance, then
 * re-evaluates the requisition's knockouts against the stored answers and the
 * candidate's parsed CV and writes knockout_passed / knockout_failures /
 * knockout_evaluated_at. Returns null when the application is not visible to
 * `db` (RLS / wrong tenant).
 *
 * Does NOT re-enqueue AI scoring when a knockout verdict flips — scoring
 * eligibility is decided once at insert time (computeInitialScoringState).
 */
export async function setApplicationScreeningAnswers(
  db: ScreeningDb,
  args: SetApplicationScreeningAnswersArgs,
): Promise<SetApplicationScreeningAnswersResult | null> {
  const now = args.now ?? new Date();
  const a = args.answers;
  const patch: Partial<ScreeningInsertColumns> = {};
  if (a.noticePeriodDays !== undefined) patch.noticePeriodDays = a.noticePeriodDays;
  if (a.currentSalaryInrPaise !== undefined)
    patch.currentSalaryInrPaise = toBigintOrNull(a.currentSalaryInrPaise) ?? null;
  if (a.expectedSalaryInrPaise !== undefined)
    patch.expectedSalaryInrPaise = toBigintOrNull(a.expectedSalaryInrPaise) ?? null;
  if (a.currentLocation !== undefined)
    patch.currentLocation = cleanLocation(a.currentLocation) ?? null;

  const scope = and(
    eq(applications.tenantId, args.tenantId),
    eq(applications.id, args.applicationId),
  );
  const [updated] = await db
    .update(applications)
    .set({
      ...patch,
      screeningAnswersSource: args.source,
      screeningAnswersUpdatedAt: now,
      updatedAt: now,
    })
    .where(scope)
    .returning({
      ...screeningAnswerColumns,
      requisitionId: applications.requisitionId,
      candidateId: applications.candidateId,
    });
  if (!updated) return null;

  const stored: StoredScreeningAnswers = {
    noticePeriodDays: updated.noticePeriodDays,
    currentSalaryInrPaise: updated.currentSalaryInrPaise,
    expectedSalaryInrPaise: updated.expectedSalaryInrPaise,
    currentLocation: updated.currentLocation,
    screeningAnswersSource: updated.screeningAnswersSource,
    screeningAnswersUpdatedAt: updated.screeningAnswersUpdatedAt,
  };

  const [cand] = await db
    .select({ parsedSkills: candidates.parsedSkills })
    .from(candidates)
    .where(and(eq(candidates.tenantId, args.tenantId), eq(candidates.id, updated.candidateId)))
    .limit(1);
  const parsedCv = cand?.parsedSkills ?? null;

  if (args.reevaluateKnockouts === false) {
    return { stored, knockout: null, knockoutEvaluatedAt: null, parsedCv };
  }

  const inputs = await loadRequisitionKnockoutInputs(db, args.tenantId, updated.requisitionId);
  const knockout = evaluateKnockouts(parsedCv, inputs, screeningKnockoutView(stored));
  await db
    .update(applications)
    .set({
      knockoutPassed: knockout.passed,
      knockoutFailures: knockout.failures.length > 0 ? knockout.failures : null,
      knockoutEvaluatedAt: now,
    })
    .where(scope);
  return { stored, knockout, knockoutEvaluatedAt: now, parsedCv };
}
