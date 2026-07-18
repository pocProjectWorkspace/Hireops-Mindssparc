/**
 * Offboarding case lifecycle — shared server-side creation + checklist
 * generation + the Workday terminate outbox seam (OFFBOARD-02).
 *
 * Mirrors apps/api/src/lib/onboarding-case.ts: all work runs through a
 * postgres.js `sql` client with an EXPLICIT tenant_id on every statement, and
 * the terminate-enqueue is best-effort + idempotent-per-case exactly like
 * ONBOARD-06's `enqueueDayZeroWorkdayHire`.
 *
 * Reality #113: raw sql fragments can't serialize JS Dates, so every date
 * interpolated below is a 'YYYY-MM-DD' string with an explicit `::date` cast.
 */

import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/**
 * OFFBOARD-02 — the Workday **terminate** event type. The offboarding mirror
 * of onboarding's `hire_employee_day_zero`: on advance-to-completed we enqueue
 * a Termination transaction to the SAME workday_sync_outbox the hire path
 * uses. Distinct event_type so the sim drain and Integration Health can tell
 * a departure from an arrival.
 */
export const TERMINATE_EVENT_TYPE = "terminate_employee";

/**
 * Idempotency key for the terminate event — one per case. A re-advance or a
 * race (two concurrent transitions both reading `clearance`) collapses to a
 * single outbox row via the unique(tenant_id, business_key) index. Uses a
 * `terminate:case:` prefix so it can never collide with the hire path's
 * `hire:application:` / `day_zero_hire:case:` keys.
 */
export function terminateBusinessKey(caseId: string): string {
  return `terminate:case:${caseId}`;
}

/**
 * The standard offboarding clearance checklist — one task per offboarding_task
 * type (OFFBOARD-01 CHECK: 7 types). Assignee mapping (flagged in the
 * hand-back): the MANAGER owns knowledge_transfer + manager_signoff; the
 * INITIATOR (HR) owns the rest (asset_return, access_revocation,
 * final_settlement, exit_interview, hr_clearance). When no manager is set the
 * manager tasks are created UNASSIGNED (null) — honest, and re-assignable on
 * the OFFBOARD-03 surface.
 */
const CHECKLIST: { taskType: string; title: string; owner: "manager" | "initiator" }[] = [
  {
    taskType: "knowledge_transfer",
    title: "Knowledge transfer & handover",
    owner: "manager",
  },
  {
    taskType: "asset_return",
    title: "Return company assets (laptop, peripherals, ID card)",
    owner: "initiator",
  },
  {
    taskType: "access_revocation",
    title: "Revoke system & building access",
    owner: "initiator",
  },
  {
    taskType: "final_settlement",
    title: "Full & final settlement",
    owner: "initiator",
  },
  {
    taskType: "exit_interview",
    title: "Conduct exit interview",
    owner: "initiator",
  },
  {
    taskType: "manager_signoff",
    title: "Manager sign-off",
    owner: "manager",
  },
  {
    taskType: "hr_clearance",
    title: "HR clearance",
    owner: "initiator",
  },
];

export interface CreateOffboardingCaseArgs {
  tenantId: string;
  candidateId: string;
  initiationType: "resignation" | "termination" | "end_of_contract";
  noticeStartDate?: string | null;
  lastWorkingDay?: string | null;
  reason?: string | null;
  initiatedByMembershipId: string;
  managerMembershipId?: string | null;
}

export interface CreateOffboardingCaseResult {
  caseId: string;
  tasksCreated: number;
}

/** Thrown when the candidate has no hire history (accepted offer / onboarding). */
export class NotHiredError extends Error {
  constructor(candidateId: string) {
    super(`candidate ${candidateId} has no hire history (no accepted offer or onboarding case)`);
    this.name = "NotHiredError";
  }
}

/** Thrown when a non-cancelled offboarding case already exists for the candidate. */
export class ActiveCaseExistsError extends Error {
  constructor(
    candidateId: string,
    public readonly existingCaseId: string,
  ) {
    super(`candidate ${candidateId} already has an active offboarding case`);
    this.name = "ActiveCaseExistsError";
  }
}

/**
 * HIRED PREDICATE (flagged): HireOps has no employees table (HANDOVER —
 * OFFBOARD-01 header). The honest "this person was actually employed" signal
 * in the data is the offer-accept moment and its downstream onboarding case:
 *   hired ⇔ the candidate has an accepted offer on one of their applications
 *            OR an onboarding_case exists for them.
 * We also pull the back-link context from that history: the application behind
 * the most-recent accepted offer, and the latest onboarding_case (for its
 * candidate/manager continuity on the OFFBOARD-03 surface). Both nullable —
 * the case survives without them (compliance artifact, OFFBOARD-01 header).
 */
async function resolveHireContext(
  sql: PgSqlClient,
  tenantId: string,
  candidateId: string,
): Promise<{ applicationId: string | null; onboardingCaseId: string | null }> {
  const [row] = await sql<{ application_id: string | null; onboarding_case_id: string | null }[]>`
    SELECT
      (
        SELECT o.application_id
        FROM public.offers o
        JOIN public.applications a
          ON a.id = o.application_id AND a.tenant_id = o.tenant_id
        WHERE o.tenant_id = ${tenantId}
          AND a.candidate_id = ${candidateId}
          AND o.status = 'accepted'
        ORDER BY o.updated_at DESC
        LIMIT 1
      ) AS application_id,
      (
        SELECT oc.id
        FROM public.onboarding_cases oc
        WHERE oc.tenant_id = ${tenantId}
          AND oc.candidate_id = ${candidateId}
        ORDER BY oc.created_at DESC
        LIMIT 1
      ) AS onboarding_case_id
  `;
  return {
    applicationId: row?.application_id ?? null,
    onboardingCaseId: row?.onboarding_case_id ?? null,
  };
}

/**
 * Open one offboarding case for a HIRED candidate and generate the standard
 * 7-task checklist. Throws NotHiredError (candidate never employed) or
 * ActiveCaseExistsError (a live case already exists — the partial-unique
 * guard). The insert additionally relies on
 * `uniq_offboarding_cases_active_per_candidate` (23505) for race safety.
 */
export async function createOffboardingCase(
  sql: PgSqlClient,
  args: CreateOffboardingCaseArgs,
): Promise<CreateOffboardingCaseResult> {
  const {
    tenantId,
    candidateId,
    initiationType,
    noticeStartDate,
    lastWorkingDay,
    reason,
    initiatedByMembershipId,
    managerMembershipId,
  } = args;

  // 1. Hired predicate + back-link context.
  const { applicationId, onboardingCaseId } = await resolveHireContext(sql, tenantId, candidateId);
  if (!applicationId && !onboardingCaseId) {
    throw new NotHiredError(candidateId);
  }

  // 2. Fast-path pre-check for a clean 409 (the unique index is the real guard).
  const [active] = await sql<{ id: string }[]>`
    SELECT id FROM public.offboarding_cases
    WHERE tenant_id = ${tenantId} AND candidate_id = ${candidateId} AND status <> 'cancelled'
    LIMIT 1
  `;
  if (active) {
    throw new ActiveCaseExistsError(candidateId, active.id);
  }

  // 3. Insert the case. A concurrent initiate hits the partial-unique 23505,
  //    which we map to ActiveCaseExistsError below.
  let caseId: string;
  try {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO public.offboarding_cases
        (tenant_id, candidate_id, application_id, onboarding_case_id, initiation_type,
         status, notice_start_date, last_working_day, reason,
         initiated_by_membership_id, manager_membership_id)
      VALUES (
        ${tenantId}, ${candidateId}, ${applicationId}, ${onboardingCaseId}, ${initiationType},
        'initiated', ${noticeStartDate ?? null}::date, ${lastWorkingDay ?? null}::date,
        ${reason ?? null}, ${initiatedByMembershipId}, ${managerMembershipId ?? null}
      )
      RETURNING id
    `;
    const insertedRow = inserted[0];
    if (!insertedRow) {
      throw new Error("createOffboardingCase: insert returned no row");
    }
    caseId = insertedRow.id;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === "23505" && e.constraint_name === "uniq_offboarding_cases_active_per_candidate") {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM public.offboarding_cases
        WHERE tenant_id = ${tenantId} AND candidate_id = ${candidateId} AND status <> 'cancelled'
        LIMIT 1
      `;
      throw new ActiveCaseExistsError(candidateId, existing?.id ?? "unknown");
    }
    throw err;
  }

  // 4. Generate the 7-task checklist.
  let tasksCreated = 0;
  for (const task of CHECKLIST) {
    const assignee =
      task.owner === "manager" ? (managerMembershipId ?? null) : initiatedByMembershipId;
    await sql`
      INSERT INTO public.offboarding_tasks
        (tenant_id, case_id, task_type, status, title, assignee_membership_id)
      VALUES (
        ${tenantId}, ${caseId}, ${task.taskType}, 'pending', ${task.title}, ${assignee}
      )
    `;
    tasksCreated += 1;
  }

  return { caseId, tasksCreated };
}

/**
 * OFFBOARD-02 — enqueue the Workday **terminate** (Termination) outbox event
 * for a case that has just advanced to `completed`. Best-effort + idempotent
 * per case (mirrors ONBOARD-06's `enqueueDayZeroWorkdayHire`): a duplicate
 * business key or any other failure is logged, never thrown — the status
 * transition must not roll back on a sync-enqueue hiccup.
 *
 * Returns whether a NEW outbox row was enqueued (false = already queued). The
 * payload carries `offboarding_case_id` (NOT onboarding_case_id — so the
 * drain's onboarding write-back branch deliberately does NOT fire; there is no
 * worker-ID equivalent to write back, and a case-side terminate marker column
 * is an OFFBOARD-03-or-later call — see the hand-back).
 */
export async function enqueueTerminateWorkday(
  sql: PgSqlClient,
  args: { tenantId: string; caseId: string; log: Logger },
): Promise<boolean> {
  const { tenantId, caseId, log } = args;

  const [row] = await sql<
    {
      application_id: string | null;
      full_name: string | null;
      email: string | null;
      last_working_day: string | null;
      initiation_type: string;
      workday_worker_id: string | null;
    }[]
  >`
    SELECT
      oc.application_id,
      p.full_name,
      p.email_primary AS email,
      oc.last_working_day::text AS last_working_day,
      oc.initiation_type,
      onb.workday_worker_id
    FROM public.offboarding_cases oc
    JOIN public.candidates c ON c.id = oc.candidate_id AND c.tenant_id = oc.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = oc.tenant_id
    LEFT JOIN public.onboarding_cases onb
      ON onb.id = oc.onboarding_case_id AND onb.tenant_id = oc.tenant_id
    WHERE oc.tenant_id = ${tenantId} AND oc.id = ${caseId}
    LIMIT 1
  `;
  if (!row) {
    log.error({ case_id: caseId }, "offboarding.terminate_payload_lookup_failed");
    return false;
  }

  const payload = {
    worker: {
      full_name: row.full_name,
      email: row.email,
      // The Worker ID minted by the ONBOARD-06 hire sim, when this departure
      // links back to an onboarding case. Null for imported/legacy hires.
      workday_worker_id: row.workday_worker_id ?? null,
    },
    termination: {
      reason_type: row.initiation_type,
      effective_date: row.last_working_day,
    },
    effective_date: row.last_working_day,
    offboarding_case_id: caseId,
    source: {
      application_id: row.application_id,
      offboarding_case_id: caseId,
      terminated_at: new Date().toISOString(),
    },
  };

  const businessKey = terminateBusinessKey(caseId);
  try {
    await sql`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, subject_application_id, payload)
      VALUES (${tenantId}, ${TERMINATE_EVENT_TYPE}, ${businessKey},
              ${row.application_id}, ${JSON.stringify(payload)}::jsonb)
    `;
    log.info({ case_id: caseId, business_key: businessKey }, "offboarding.terminate_enqueued");
    return true;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === "23505" || e.constraint_name === "uniq_workday_sync_outbox_business_key") {
      log.info(
        { case_id: caseId, business_key: businessKey },
        "offboarding.terminate_already_queued",
      );
      return false;
    }
    log.error({ err, case_id: caseId }, "offboarding.terminate_enqueue_failed");
    return false;
  }
}
