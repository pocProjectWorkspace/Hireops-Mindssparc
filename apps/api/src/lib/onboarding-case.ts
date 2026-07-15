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
import type { Logger } from "@hireops/observability";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/**
 * ONBOARD-06 — the Day-0 hire event type. Distinct from the accept-path
 * `hire_employee` event (offers.ts), which models the Workday **Pre-Hire**
 * creation fired on offer-accept (requirements.md §7.2 — "Put_Applicant").
 * This is the later **Hire_Employee** transaction (§7.2) that converts the
 * pre-hire into an active Worker and yields the permanent Worker ID. The
 * two are deliberately separate outbox events; this one carries the
 * onboarding case id so the drain can write the Worker ID back to it.
 */
export const DAY_ZERO_HIRE_EVENT_TYPE = "hire_employee_day_zero";

/**
 * Idempotency key for the Day-0 hire — one per case. A re-advance or a race
 * (two concurrent transitions both reading `pre_boarding`) collapses to a
 * single outbox row via the unique(tenant_id, business_key) index. Uses a
 * `day_zero_hire:case:` prefix so it can never collide with the accept
 * path's `hire:application:` pre-hire key on the same application.
 */
export function dayZeroHireBusinessKey(caseId: string): string {
  return `day_zero_hire:case:${caseId}`;
}

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

/**
 * ONBOARD-06 — enqueue the Day-0 Workday **hire** (Hire_Employee) outbox event
 * for a case that has just advanced to `day_zero`. Best-effort, mirroring the
 * accept-path `enqueueWorkdayHire` in offers.ts: a duplicate business key
 * (already queued) or any other failure is logged, never thrown — the status
 * transition must not roll back on a sync-enqueue hiccup.
 *
 * The payload carries `onboarding_case_id`, which is the signal the workers'
 * simulation drain uses to write the resulting mock Worker ID back onto the
 * case (permanent linkage, requirements.md §7.2). Runs through the caller's
 * explicit-tenant `sql` client (ctx.sql), same discipline as the rest of this
 * module.
 */
export async function enqueueDayZeroWorkdayHire(
  sql: PgSqlClient,
  args: { tenantId: string; caseId: string; log: Logger },
): Promise<void> {
  const { tenantId, caseId, log } = args;

  const [row] = await sql<
    {
      application_id: string;
      full_name: string | null;
      email: string | null;
      expected_start_date: string | null;
      actual_start_date: string | null;
      title: string | null;
      business_unit_name: string | null;
      location: string | null;
    }[]
  >`
    SELECT
      oc.application_id,
      p.full_name,
      p.email_primary AS email,
      oc.expected_start_date::text AS expected_start_date,
      oc.actual_start_date::text AS actual_start_date,
      pos.title,
      bu.name AS business_unit_name,
      pos.location_type AS location
    FROM public.onboarding_cases oc
    JOIN public.candidates c ON c.id = oc.candidate_id AND c.tenant_id = oc.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = oc.tenant_id
    JOIN public.applications a ON a.id = oc.application_id AND a.tenant_id = oc.tenant_id
    JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = oc.tenant_id
    JOIN public.positions pos ON pos.id = r.position_id AND pos.tenant_id = oc.tenant_id
    JOIN public.business_units bu ON bu.id = pos.business_unit_id AND bu.tenant_id = oc.tenant_id
    WHERE oc.tenant_id = ${tenantId} AND oc.id = ${caseId}
    LIMIT 1
  `;
  if (!row) {
    log.error({ case_id: caseId }, "onboarding.day_zero_hire_payload_lookup_failed");
    return;
  }

  const effectiveDate = row.actual_start_date ?? row.expected_start_date;
  const payload = {
    pre_hire: {
      full_name: row.full_name,
      email: row.email,
    },
    position: {
      title: row.title,
      business_unit_name: row.business_unit_name,
      location: row.location,
    },
    effective_date: effectiveDate,
    onboarding_case_id: caseId,
    source: {
      application_id: row.application_id,
      onboarding_case_id: caseId,
      hired_at: new Date().toISOString(),
    },
  };

  const businessKey = dayZeroHireBusinessKey(caseId);
  try {
    await sql`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, subject_application_id, payload)
      VALUES (${tenantId}, ${DAY_ZERO_HIRE_EVENT_TYPE}, ${businessKey},
              ${row.application_id}, ${JSON.stringify(payload)}::jsonb)
    `;
    log.info({ case_id: caseId, business_key: businessKey }, "onboarding.day_zero_hire_enqueued");
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === "23505" || e.constraint_name === "uniq_workday_sync_outbox_business_key") {
      log.info(
        { case_id: caseId, business_key: businessKey },
        "onboarding.day_zero_hire_already_queued",
      );
      return;
    }
    log.error({ err, case_id: caseId }, "onboarding.day_zero_hire_enqueue_failed");
  }
}
