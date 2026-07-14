/**
 * Onboarding case lifecycle — shared server-side creation + checklist
 * generation (ONBOARD-02).
 *
 * One case per accepted hire. `createOnboardingCaseForApplication` is the
 * single idempotent entry point, reused by:
 *   - the public offer-accept route (apps/api/src/routes/offers.ts), which
 *     opens the case as a best-effort side-effect of a winning acceptance;
 *   - the `createOnboardingCaseForApplication` tRPC procedure (manual /
 *     backfill).
 *
 * All work runs through a postgres.js `sql` client with an EXPLICIT
 * tenant_id on every statement — same discipline as offers.ts. The accept
 * route passes the service-role pool (`poolSql`); the tRPC backfill passes
 * `ctx.sql`. Idempotency is enforced by the unique(tenant_id,
 * application_id) constraint (migration 0049) + ON CONFLICT DO NOTHING, so
 * a double-accept or a re-run collapses to a single case and generates the
 * checklist exactly once.
 *
 * Reality #113: raw sql fragments can't serialize JS Dates, so every date
 * interpolated below is a `.toISOString()` string with an explicit
 * `::timestamptz` / `::date` cast.
 */

import { sql as poolSql } from "@hireops/db";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/** requirements.md §7.3 — probation defaults to 90 days (configurable to 180). */
const DEFAULT_PROBATION_DAYS = 90;

/** requirements.md §7.3 — structured check-ins at day 7 / 14 / 30. */
const CHECK_IN_DAYS = [7, 14, 30] as const;

export interface CreateOnboardingCaseResult {
  caseId: string;
  /** false when the case already existed (idempotent no-op on the checklist). */
  created: boolean;
  geographyCode: string;
}

/**
 * onboarding_cases.geography_code is NOT NULL char(2) (ONBOARD-01 schema),
 * so the ticket's "fall back to NULL → common documents only" is not
 * storable. We source the code from persons.location_country (ISO-3166
 * alpha-2, e.g. 'IN'); when it is absent or not a 2-char code we default to
 * 'IN' — the Kyndryl GCC (tenant #1) is India-based and the demo data is
 * India-only. A non-IN/PH but valid code (e.g. 'US') is honoured verbatim
 * and naturally yields common documents only (no geography-specific
 * document_types rows match). The code is correctable post-hoc via
 * updateOnboardingCase, which soft-adds the newly-applicable document tasks.
 */
export function resolveGeographyCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase();
  return code.length === 2 ? code : "IN";
}

/** Add whole days to a 'YYYY-MM-DD' date, returning a UTC-midnight ISO string. */
function addDaysUtcIso(dateStr: string | null, days: number): string | null {
  if (!dateStr) return null;
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
}

/** Add whole days to a 'YYYY-MM-DD' date, returning a 'YYYY-MM-DD' string. */
function addDaysUtcDate(dateStr: string | null, days: number): string | null {
  const iso = addDaysUtcIso(dateStr, days);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * Insert one `document_collection` task per applicable document_types row —
 * the geography-agnostic rows (geography_code IS NULL) plus the rows
 * matching the case's geography — for the pre_boarding lifecycle stage.
 * Guarded by NOT EXISTS on the document-type reference in `metadata`, so it
 * is safe to call both at case creation (adds all applicable types) and on
 * a later geography change (soft-adds only the newly-applicable types,
 * leaving existing tasks — and any progress on them — untouched). Returns
 * the number of tasks added.
 */
export async function ensureDocumentCollectionTasks(
  sql: PgSqlClient,
  args: { tenantId: string; caseId: string; geographyCode: string },
): Promise<number> {
  const { tenantId, caseId, geographyCode } = args;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.onboarding_tasks
      (tenant_id, case_id, task_type, status, title, metadata)
    SELECT
      ${tenantId},
      ${caseId},
      'document_collection',
      'pending',
      dt.name,
      jsonb_build_object(
        'documentTypeId', dt.id,
        'documentTypeCode', dt.code,
        'geographyCode', dt.geography_code
      )
    FROM public.document_types dt
    WHERE dt.required_for_lifecycle_stage = 'pre_boarding'
      AND (dt.geography_code IS NULL OR dt.geography_code = ${geographyCode})
      AND NOT EXISTS (
        SELECT 1
        FROM public.onboarding_tasks t
        WHERE t.tenant_id = ${tenantId}
          AND t.case_id = ${caseId}
          AND t.task_type = 'document_collection'
          AND t.metadata->>'documentTypeId' = dt.id::text
      )
    RETURNING id
  `;
  return inserted.length;
}

/**
 * The standard (non-document) onboarding checklist: IT provisioning, buddy
 * assignment, mandatory training, day 7/14/30 check-ins, and the probation
 * review. Check-in `due_at` is the expected start date + N days; the
 * probation review is start + probation_days. Dates are left NULL when the
 * expected start date is unknown. Generated once, at case creation only.
 */
async function createStandardTasks(
  sql: PgSqlClient,
  args: {
    tenantId: string;
    caseId: string;
    expectedStartDate: string | null;
    probationDays: number;
  },
): Promise<void> {
  const { tenantId, caseId, expectedStartDate, probationDays } = args;

  const tasks: {
    taskType: string;
    title: string;
    dueAtIso: string | null;
    metadata: Record<string, unknown> | null;
  }[] = [
    {
      taskType: "it_provisioning",
      title: "Provision IT accounts, email, and equipment",
      dueAtIso: null,
      metadata: null,
    },
    {
      taskType: "buddy_assignment",
      title: "Assign an onboarding buddy",
      dueAtIso: null,
      metadata: null,
    },
    {
      taskType: "training",
      title: "Complete mandatory onboarding training",
      dueAtIso: null,
      metadata: null,
    },
    ...CHECK_IN_DAYS.map((day) => ({
      taskType: "check_in",
      title: `Day ${day} check-in`,
      dueAtIso: addDaysUtcIso(expectedStartDate, day),
      metadata: { checkInDay: day } as Record<string, unknown>,
    })),
    {
      taskType: "probation_review",
      title: "Probation review",
      dueAtIso: addDaysUtcIso(expectedStartDate, probationDays),
      metadata: { probationDays },
    },
  ];

  for (const task of tasks) {
    await sql`
      INSERT INTO public.onboarding_tasks
        (tenant_id, case_id, task_type, status, title, due_at, metadata)
      VALUES (
        ${tenantId},
        ${caseId},
        ${task.taskType},
        'pending',
        ${task.title},
        ${task.dueAtIso}::timestamptz,
        ${task.metadata ? JSON.stringify(task.metadata) : null}::jsonb
      )
    `;
  }
}

/**
 * Idempotently open one onboarding case for an accepted application and
 * generate its task checklist. Safe to call more than once per application:
 * the second call is a no-op that returns the existing case with
 * `created: false`.
 *
 * Geography is derived from the candidate's person.location_country; the
 * expected start date is the accepted offer's joining_date (max across
 * accepted offers, matching the recruiter-notice lookup in offers.ts).
 */
export async function createOnboardingCaseForApplication(
  sql: PgSqlClient,
  args: { tenantId: string; applicationId: string },
): Promise<CreateOnboardingCaseResult> {
  const { tenantId, applicationId } = args;

  // 1. Resolve the hire context (candidate, geography, expected start).
  const [row] = await sql<
    {
      candidate_id: string;
      geography_code: string | null;
      expected_start_date: string | null;
    }[]
  >`
    SELECT
      a.candidate_id,
      p.location_country AS geography_code,
      (
        SELECT MAX(o.joining_date)::text
        FROM public.offers o
        WHERE o.tenant_id = a.tenant_id
          AND o.application_id = a.id
          AND o.status = 'accepted'
      ) AS expected_start_date
    FROM public.applications a
    JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = a.tenant_id
    WHERE a.id = ${applicationId} AND a.tenant_id = ${tenantId}
    LIMIT 1
  `;
  if (!row) {
    throw new Error(
      `createOnboardingCaseForApplication: application ${applicationId} not found for tenant ${tenantId}`,
    );
  }

  const geographyCode = resolveGeographyCode(row.geography_code);
  const expectedStartDate = row.expected_start_date;
  const probationDays = DEFAULT_PROBATION_DAYS;
  const probationEndsAt = addDaysUtcDate(expectedStartDate, probationDays);

  // 2. Idempotent case insert. unique(tenant_id, application_id) (0049)
  //    collapses a double-accept / backfill to a single row.
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.onboarding_cases
      (tenant_id, application_id, candidate_id, status, geography_code,
       expected_start_date, probation_days, probation_ends_at)
    VALUES (
      ${tenantId},
      ${applicationId},
      ${row.candidate_id},
      'pre_boarding',
      ${geographyCode},
      ${expectedStartDate}::date,
      ${probationDays},
      ${probationEndsAt}::date
    )
    ON CONFLICT (tenant_id, application_id) DO NOTHING
    RETURNING id
  `;

  const insertedRow = inserted[0];
  if (!insertedRow) {
    // A case already exists — return it, generate nothing.
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM public.onboarding_cases
      WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
      LIMIT 1
    `;
    if (!existing) {
      throw new Error(
        `createOnboardingCaseForApplication: ON CONFLICT hit but no existing case for ${applicationId}`,
      );
    }
    return { caseId: existing.id, created: false, geographyCode };
  }

  const caseId = insertedRow.id;

  // 3. Generate the checklist (first creation only).
  await ensureDocumentCollectionTasks(sql, { tenantId, caseId, geographyCode });
  await createStandardTasks(sql, { tenantId, caseId, expectedStartDate, probationDays });

  return { caseId, created: true, geographyCode };
}
