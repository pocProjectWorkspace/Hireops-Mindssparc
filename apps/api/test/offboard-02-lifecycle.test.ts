/**
 * OFFBOARD-02 — offboarding lifecycle: initiation + checklist, task semantics,
 * advance gates, clearance-gated settlement, exit-interview immutability, the
 * Workday terminate outbox, and role gating.
 *
 * Coverage:
 *   1.  initiateOffboarding (hired candidate) → case + 7-task checklist,
 *       assignee mapping (manager: KT + signoff; HR: the rest), context pull
 *       (application/onboarding back-links).
 *   2.  Double-initiation → CONFLICT (partial-unique one-active-per-candidate).
 *   3.  Non-hired candidate → BAD_REQUEST.
 *   4.  updateOffboardingTaskStatus — → completed stamps; → blocked needs reason.
 *   5.  advance guards — → clearance without LWD rejected; → completed without
 *       the clearance gates rejected; happy path walks to completed.
 *   6.  updateFinalSettlement — → approved blocked until access_revocation done.
 *   7.  recordExitInterview — immutable once submitted.
 *   8.  Terminate outbox — enqueue is idempotent per case (twice → one row);
 *       advance-to-completed enqueues it; the sim mock generator has a
 *       Termination branch.
 *   9.  Role gating — recruiter is FORBIDDEN.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import {
  enqueueTerminateWorkday,
  terminateBusinessKey,
  TERMINATE_EVENT_TYPE,
} from "../src/lib/offboarding-case.js";
import { generateMockWorkdayResponse } from "../../../apps/workers/src/lib/workday-simulation-drain.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Fixed synthetic fixtures (hex-only, UUIDv4-valid; '0f02' ~ "offboard-02").
const OFF_BU = "00000000-0000-4000-8000-00000f020001";
const OFF_POSITION = "00000000-0000-4000-8000-00000f020002";
const OFF_JD = "00000000-0000-4000-8000-00000f020003";
const OFF_REQ = "00000000-0000-4000-8000-00000f020004";
const EMAIL_MARKER = "@off02.test";

const wdLog = createLogger({ level: "error" });

let hrOpsJwt: string;
let recruiterJwt: string;
let tenantId: string;
let hrOpsMembershipId: string;
let managerMembershipId: string;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
function dataOf<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}

async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface SeedHireOpts {
  suffix: string;
  /** false → no accepted offer + no onboarding case (non-hired). */
  hired?: boolean;
  /** true → also create an onboarding_case for the candidate (back-link). */
  withOnboardingCase?: boolean;
  lastWorkingDay?: string;
}
interface Hire {
  candidateId: string;
  applicationId: string;
  onboardingCaseId: string | null;
}

async function seedHire(opts: SeedHireOpts): Promise<Hire> {
  const personId = randomUUID();
  const candidateId = randomUUID();
  const applicationId = randomUUID();
  const email = `${opts.suffix}${EMAIL_MARKER}`;
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${personId}, ${tenantId}, ${"Off " + opts.suffix}, ${email}, ${email}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candidateId}, ${tenantId}, ${personId}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${applicationId}, ${tenantId}, ${candidateId}, ${OFF_REQ}, 'career_site',
            'offer_accepted', now())
  `;
  const hired = opts.hired ?? true;
  if (hired) {
    await poolSql`
      INSERT INTO public.offers
        (tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status)
      VALUES (${tenantId}, ${applicationId}, ${hrOpsMembershipId}, ${4_200_000 * 100},
              '2024-01-01', 'Bengaluru', now() + interval '7 days', 'accepted')
    `;
  }
  let onboardingCaseId: string | null = null;
  if (opts.withOnboardingCase) {
    onboardingCaseId = randomUUID();
    await poolSql`
      INSERT INTO public.onboarding_cases
        (id, tenant_id, application_id, candidate_id, status, geography_code, probation_days)
      VALUES (${onboardingCaseId}, ${tenantId}, ${applicationId}, ${candidateId},
              'in_progress', 'IN', 90)
    `;
  }
  return { candidateId, applicationId, onboardingCaseId };
}

async function outboxCountForCase(caseId: string): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.workday_sync_outbox
    WHERE tenant_id = ${tenantId} AND business_key = ${terminateBusinessKey(caseId)}
  `;
  return Number(row?.n ?? 0);
}

async function cleanup(): Promise<void> {
  // Terminate outbox rows FK applications (NO ACTION) — clear before apps.
  await poolSql`
    DELETE FROM public.workday_sync_outbox
    WHERE subject_application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${OFF_REQ})
  `;
  // offboarding_cases FK candidate/application/onboarding_case with RESTRICT —
  // delete cases first (cascades tasks / asset_returns / exit_interviews /
  // final_settlements).
  await poolSql`
    DELETE FROM public.offboarding_cases
    WHERE tenant_id = ${tenantId}
      AND candidate_id IN (
        SELECT c.id FROM public.candidates c
        JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
        WHERE p.email_normalised LIKE ${"%" + EMAIL_MARKER}
      )
  `;
  await poolSql`
    DELETE FROM public.onboarding_cases
    WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${OFF_REQ})
  `;
  await poolSql`
    DELETE FROM public.application_state_transitions
    WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${OFF_REQ})
  `;
  await poolSql`DELETE FROM public.applications WHERE requisition_id = ${OFF_REQ}`;
  await poolSql`
    DELETE FROM public.candidates
    WHERE tenant_id = ${tenantId}
      AND person_id IN (SELECT id FROM public.persons WHERE email_normalised LIKE ${"%" + EMAIL_MARKER})
  `;
  await poolSql`
    DELETE FROM public.persons
    WHERE tenant_id = ${tenantId} AND email_normalised LIKE ${"%" + EMAIL_MARKER}
  `;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${OFF_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${OFF_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${OFF_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${OFF_BU}`;
}

interface TaskRow {
  id: string;
  taskType: string;
  status: string;
  assigneeMembershipId: string | null;
}
async function tasksForCase(caseId: string): Promise<TaskRow[]> {
  const rows = await poolSql<
    { id: string; task_type: string; status: string; assignee_membership_id: string | null }[]
  >`
    SELECT id, task_type, status, assignee_membership_id
    FROM public.offboarding_tasks WHERE case_id = ${caseId} ORDER BY created_at, id
  `;
  return rows.map((r) => ({
    id: r.id,
    taskType: r.task_type,
    status: r.status,
    assigneeMembershipId: r.assignee_membership_id,
  }));
}

async function completeTask(caseId: string, taskType: string): Promise<void> {
  const [t] = (await tasksForCase(caseId)).filter((x) => x.taskType === taskType);
  assert.ok(t, `task ${taskType} not found`);
  const env = await trpcMutation(
    "updateOffboardingTaskStatus",
    {
      taskId: t.id,
      status: "completed",
    },
    hrOpsJwt,
  );
  assert.ok(!isErr(env), `complete ${taskType}: ${JSON.stringify(env)}`);
}

describe("OFFBOARD-02 — offboarding lifecycle", () => {
  beforeAll(async () => {
    [hrOpsJwt, recruiterJwt] = await Promise.all([signIn(HR_OPS), signIn(RECRUITER)]);
    const adminJwt = await signIn(ADMIN);
    void adminJwt;
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    const membershipFor = async (email: string): Promise<string> => {
      const [m] = await poolSql<{ id: string }[]>`
        SELECT tum.id FROM public.tenant_user_memberships tum
        JOIN auth.users au ON au.id = tum.user_id
        WHERE tum.tenant_id = ${tenantId} AND au.email = ${email} LIMIT 1
      `;
      if (!m) throw new Error(`membership for ${email} not found`);
      return m.id;
    };
    hrOpsMembershipId = await membershipFor(HR_OPS);
    managerMembershipId = await membershipFor(ADMIN);

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${OFF_BU}, ${tenantId}, 'OFF BU', 'off-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${OFF_POSITION}, ${tenantId}, ${OFF_BU}, 'OFF Engineer', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${OFF_JD}, ${tenantId}, ${OFF_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${OFF_REQ}, ${tenantId}, ${OFF_POSITION}, ${OFF_JD}, ${hrOpsMembershipId}, ${hrOpsMembershipId}, 'posted')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. initiates a case + 7-task checklist with assignee mapping + context pull", async () => {
    const hire = await seedHire({ suffix: "init", withOnboardingCase: true });

    const env = await trpcMutation<{ caseId: string; created: boolean; tasksCreated: number }>(
      "initiateOffboarding",
      {
        candidateId: hire.candidateId,
        initiationType: "resignation",
        reason: "Better opportunity",
        managerMembershipId,
      },
      hrOpsJwt,
    );
    const data = dataOf(env);
    assert.equal(data.created, true);
    assert.equal(data.tasksCreated, 7);

    const tasks = await tasksForCase(data.caseId);
    assert.equal(tasks.length, 7);
    const types = tasks.map((t) => t.taskType).sort();
    assert.deepEqual(types, [
      "access_revocation",
      "asset_return",
      "exit_interview",
      "final_settlement",
      "hr_clearance",
      "knowledge_transfer",
      "manager_signoff",
    ]);

    // Manager owns KT + signoff; HR (initiator) owns the rest.
    const byType = (t: string) => tasks.find((x) => x.taskType === t)!;
    assert.equal(byType("knowledge_transfer").assigneeMembershipId, managerMembershipId);
    assert.equal(byType("manager_signoff").assigneeMembershipId, managerMembershipId);
    for (const t of [
      "asset_return",
      "access_revocation",
      "final_settlement",
      "exit_interview",
      "hr_clearance",
    ]) {
      assert.equal(byType(t).assigneeMembershipId, hrOpsMembershipId, `${t} → HR`);
    }

    // Context pull — back-links to the application + onboarding case.
    const [caseRow] = await poolSql<
      { application_id: string | null; onboarding_case_id: string | null }[]
    >`SELECT application_id, onboarding_case_id FROM public.offboarding_cases WHERE id = ${data.caseId}`;
    assert.equal(caseRow?.application_id, hire.applicationId);
    assert.equal(caseRow?.onboarding_case_id, hire.onboardingCaseId);
  });

  it("2. rejects a double-initiation with CONFLICT", async () => {
    const hire = await seedHire({ suffix: "dup" });
    const first = await trpcMutation(
      "initiateOffboarding",
      {
        candidateId: hire.candidateId,
        initiationType: "resignation",
      },
      hrOpsJwt,
    );
    assert.ok(!isErr(first));
    const second = await trpcMutation(
      "initiateOffboarding",
      {
        candidateId: hire.candidateId,
        initiationType: "resignation",
      },
      hrOpsJwt,
    );
    assert.ok(isErr(second) && second.error.data.code === "CONFLICT", JSON.stringify(second));
  });

  it("3. rejects a non-hired candidate with BAD_REQUEST", async () => {
    const hire = await seedHire({ suffix: "nohire", hired: false });
    const env = await trpcMutation(
      "initiateOffboarding",
      {
        candidateId: hire.candidateId,
        initiationType: "resignation",
      },
      hrOpsJwt,
    );
    assert.ok(isErr(env) && env.error.data.code === "BAD_REQUEST", JSON.stringify(env));
  });

  it("4. task status — completed stamps completed_at; blocked needs a reason", async () => {
    const hire = await seedHire({ suffix: "task" });
    const data = dataOf(
      await trpcMutation<{ caseId: string }>(
        "initiateOffboarding",
        {
          candidateId: hire.candidateId,
          initiationType: "resignation",
        },
        hrOpsJwt,
      ),
    );
    const kt = (await tasksForCase(data.caseId)).find((t) => t.taskType === "knowledge_transfer")!;

    const done = dataOf(
      await trpcMutation<{ status: string; completedAt: string | null }>(
        "updateOffboardingTaskStatus",
        { taskId: kt.id, status: "completed" },
        hrOpsJwt,
      ),
    );
    assert.equal(done.status, "completed");
    assert.ok(done.completedAt, "completed_at stamped");

    const blockedNoReason = await trpcMutation(
      "updateOffboardingTaskStatus",
      {
        taskId: kt.id,
        status: "blocked",
      },
      hrOpsJwt,
    );
    assert.ok(
      isErr(blockedNoReason) && blockedNoReason.error.data.code === "BAD_REQUEST",
      JSON.stringify(blockedNoReason),
    );
  });

  it("5. advance guards — LWD gate, completion gates, and the happy walk", async () => {
    const lwd = "2024-06-30";
    const hire = await seedHire({ suffix: "advance" });
    const { caseId } = dataOf(
      await trpcMutation<{ caseId: string }>(
        "initiateOffboarding",
        {
          candidateId: hire.candidateId,
          initiationType: "resignation",
        },
        hrOpsJwt,
      ),
    );

    // initiated → notice_period (no gate).
    dataOf(
      await trpcMutation(
        "advanceOffboardingCase",
        {
          caseId,
          targetStatus: "notice_period",
        },
        hrOpsJwt,
      ),
    );

    // → clearance WITHOUT a last working day is rejected.
    const noLwd = await trpcMutation(
      "advanceOffboardingCase",
      {
        caseId,
        targetStatus: "clearance",
      },
      hrOpsJwt,
    );
    assert.ok(isErr(noLwd) && noLwd.error.data.code === "BAD_REQUEST", JSON.stringify(noLwd));

    // → clearance WITH the LWD stamped inline succeeds.
    dataOf(
      await trpcMutation(
        "advanceOffboardingCase",
        {
          caseId,
          targetStatus: "clearance",
          lastWorkingDay: lwd,
        },
        hrOpsJwt,
      ),
    );

    // → completed WITHOUT the clearance gates is rejected.
    const notReady = await trpcMutation(
      "advanceOffboardingCase",
      {
        caseId,
        targetStatus: "completed",
      },
      hrOpsJwt,
    );
    assert.ok(
      isErr(notReady) && notReady.error.data.code === "BAD_REQUEST",
      JSON.stringify(notReady),
    );

    // Satisfy the gates: complete access_revocation + asset_return, and walk the
    // settlement to approved (which itself needs access_revocation done first).
    await completeTask(caseId, "access_revocation");
    await completeTask(caseId, "asset_return");
    dataOf(
      await trpcMutation(
        "updateFinalSettlement",
        {
          caseId,
          status: "calculated",
          amountMinor: 5_000_000,
          currency: "INR",
        },
        hrOpsJwt,
      ),
    );
    dataOf(
      await trpcMutation(
        "updateFinalSettlement",
        {
          caseId,
          status: "approved",
        },
        hrOpsJwt,
      ),
    );

    // → completed now succeeds AND enqueues the terminate outbox row.
    const completed = dataOf(
      await trpcMutation<{ status: string; terminateEnqueued: boolean }>(
        "advanceOffboardingCase",
        { caseId, targetStatus: "completed" },
        hrOpsJwt,
      ),
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.terminateEnqueued, true);
    assert.equal(await outboxCountForCase(caseId), 1);
  });

  it("6. settlement approval is blocked until access_revocation is complete", async () => {
    const hire = await seedHire({ suffix: "settle" });
    const { caseId } = dataOf(
      await trpcMutation<{ caseId: string }>(
        "initiateOffboarding",
        {
          candidateId: hire.candidateId,
          initiationType: "termination",
        },
        hrOpsJwt,
      ),
    );
    dataOf(
      await trpcMutation(
        "updateFinalSettlement",
        {
          caseId,
          status: "calculated",
          amountMinor: 1_000_000,
        },
        hrOpsJwt,
      ),
    );
    // approve BEFORE access_revocation → rejected.
    const blocked = await trpcMutation(
      "updateFinalSettlement",
      {
        caseId,
        status: "approved",
      },
      hrOpsJwt,
    );
    assert.ok(isErr(blocked) && blocked.error.data.code === "BAD_REQUEST", JSON.stringify(blocked));

    await completeTask(caseId, "access_revocation");
    // now approve → paid → auto-completes the final_settlement task.
    dataOf(await trpcMutation("updateFinalSettlement", { caseId, status: "approved" }, hrOpsJwt));
    const paid = dataOf(
      await trpcMutation<{ status: string; taskAutoCompleted: boolean; paidAt: string | null }>(
        "updateFinalSettlement",
        { caseId, status: "paid" },
        hrOpsJwt,
      ),
    );
    assert.equal(paid.status, "paid");
    assert.ok(paid.paidAt, "paid_at stamped");
    assert.equal(paid.taskAutoCompleted, true);
  });

  it("7. exit interview is immutable once submitted", async () => {
    const hire = await seedHire({ suffix: "exit" });
    const { caseId } = dataOf(
      await trpcMutation<{ caseId: string }>(
        "initiateOffboarding",
        {
          candidateId: hire.candidateId,
          initiationType: "resignation",
        },
        hrOpsJwt,
      ),
    );
    // draft (not submitted) — mutable.
    dataOf(
      await trpcMutation(
        "recordExitInterview",
        {
          caseId,
          freeText: "Draft feedback",
        },
        hrOpsJwt,
      ),
    );
    // submit — stamps submitted_at + auto-completes the exit_interview task.
    const submitted = dataOf(
      await trpcMutation<{ submittedAt: string | null; taskAutoCompleted: boolean }>(
        "recordExitInterview",
        { caseId, freeText: "Final feedback", submit: true },
        hrOpsJwt,
      ),
    );
    assert.ok(submitted.submittedAt, "submitted_at stamped");
    assert.equal(submitted.taskAutoCompleted, true);
    // any further write → CONFLICT.
    const afterSubmit = await trpcMutation(
      "recordExitInterview",
      {
        caseId,
        freeText: "Cannot edit",
      },
      hrOpsJwt,
    );
    assert.ok(
      isErr(afterSubmit) && afterSubmit.error.data.code === "CONFLICT",
      JSON.stringify(afterSubmit),
    );
  });

  it("8. terminate enqueue is idempotent (twice → one row); mock generator has a Termination branch", async () => {
    const hire = await seedHire({ suffix: "term", withOnboardingCase: true });
    const { caseId } = dataOf(
      await trpcMutation<{ caseId: string }>(
        "initiateOffboarding",
        {
          candidateId: hire.candidateId,
          initiationType: "end_of_contract",
        },
        hrOpsJwt,
      ),
    );
    const first = await enqueueTerminateWorkday(poolSql, { tenantId, caseId, log: wdLog });
    const second = await enqueueTerminateWorkday(poolSql, { tenantId, caseId, log: wdLog });
    assert.equal(first, true, "first enqueue writes");
    assert.equal(second, false, "second enqueue is a no-op");
    assert.equal(await outboxCountForCase(caseId), 1);

    const resp = generateMockWorkdayResponse(TERMINATE_EVENT_TYPE, {
      worker: { full_name: "Off term" },
      effective_date: "2024-06-30",
    });
    const ref = (resp as { workday_reference?: { type?: string } }).workday_reference;
    assert.equal(ref?.type, "Termination");
  });

  it("9. role gating — a recruiter is FORBIDDEN", async () => {
    const hire = await seedHire({ suffix: "role" });
    const env = await trpcMutation(
      "initiateOffboarding",
      {
        candidateId: hire.candidateId,
        initiationType: "resignation",
      },
      recruiterJwt,
    );
    assert.ok(isErr(env) && env.error.data.code === "FORBIDDEN", JSON.stringify(env));

    // read surface too.
    const list = await trpcQuery("listOffboardingCases", {}, recruiterJwt);
    assert.ok(isErr(list) && list.error.data.code === "FORBIDDEN", JSON.stringify(list));
  });
});
