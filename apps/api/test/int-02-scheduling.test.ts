/**
 * INT-02 — interview scheduling integration tests.
 *
 * Coverage:
 *   1. upsertInterviewPlan replace-set (2 rounds → 1 round) + getInterviewPlan
 *      by requisitionId and by applicationId.
 *   2. scheduleInterview → interviews row + interview_panelists + confirm hash
 *      stored + candidate.interview_invitation notification enqueued.
 *   3. Double-schedule the same round → CONFLICT (partial-unique).
 *   4. rescheduleInterview cancels the old round + creates the replacement.
 *   5. Public confirm route: valid token stamps candidate_confirmed_at; second
 *      use rejected; the confirmed row shows on listUpcomingInterviews.
 *   6. Role gating: hr_head (no manage role) is FORBIDDEN from scheduling +
 *      plan editing.
 *
 * Requires `pnpm db:seed:test-users` (recruiter1 / hrhead1 seeded).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const I2_BU = "00000000-0000-4000-8000-000000012b01";
const I2_POSITION = "00000000-0000-4000-8000-000000012b02";
const I2_JD = "00000000-0000-4000-8000-000000012b03";
const I2_REQ = "00000000-0000-4000-8000-000000012b04";
const I2_PERSON = "00000000-0000-4000-8000-000000012b05";
const I2_CANDIDATE = "00000000-0000-4000-8000-000000012b06";
const I2_APP = "00000000-0000-4000-8000-000000012b07";

let recruiterJwt: string;
let hrHeadJwt: string;
let tenantId: string;
let recruiterMembershipId: string;

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
function data<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected tRPC error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ${I2_APP})`,
    () => poolSql`DELETE FROM public.interviews WHERE application_id = ${I2_APP}`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${I2_REQ}`,
    () =>
      poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${tenantId} AND action = 'candidate.confirm_interview'`,
    () =>
      poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ${I2_CANDIDATE}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${I2_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${I2_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${I2_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${I2_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${I2_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${I2_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${I2_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("INT-02 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${I2_BU}, ${tenantId}, 'INT02 BU', 'int02-bu')`;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${I2_POSITION}, ${tenantId}, ${I2_BU}, 'INT02 Staff Engineer', 'hybrid', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${I2_JD}, ${tenantId}, ${I2_POSITION}, 1, '# JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${I2_REQ}, ${tenantId}, ${I2_POSITION}, ${I2_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${I2_PERSON}, ${tenantId}, 'Priya Subramanian', 'priya.int02@example.com', 'priya.int02@example.com')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${I2_CANDIDATE}, ${tenantId}, ${I2_PERSON}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${I2_APP}, ${tenantId}, ${I2_CANDIDATE}, ${I2_REQ}, 'career_site', 'tech_interview', now())
  `;
}

async function resetSchedulingState(): Promise<void> {
  await poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ${I2_APP})`;
  await poolSql`DELETE FROM public.interviews WHERE application_id = ${I2_APP}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ${I2_CANDIDATE}`;
  await poolSql`DELETE FROM public.signed_link_uses WHERE action = 'candidate.confirm_interview'`;
}

function futureStart(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 19);
}

async function ensurePlan(): Promise<void> {
  const res = await trpcMutation(
    "upsertInterviewPlan",
    {
      requisitionId: I2_REQ,
      rounds: [
        {
          roundNumber: 1,
          roundName: "Technical Screen",
          durationMinutes: 60,
          mode: "video",
          scorecardTemplate: "technical",
          competencyFocus: ["system_design"],
          defaultPanelMembershipIds: [recruiterMembershipId],
        },
      ],
    },
    recruiterJwt,
  );
  data(res);
}

async function extractConfirmToken(): Promise<string> {
  const [row] = await poolSql<{ template_data: { confirmUrl?: string } }[]>`
    SELECT template_data FROM public.notification_outbox
    WHERE tenant_id = ${tenantId}
      AND recipient_candidate_id = ${I2_CANDIDATE}
      AND template_key = 'candidate.interview_invitation'
    ORDER BY created_at DESC LIMIT 1
  `;
  const url = row?.template_data?.confirmUrl;
  assert.ok(url, "confirmUrl missing from invitation templateData");
  const token = url.split("/interviews/confirm/")[1];
  assert.ok(token, `could not parse token from ${url}`);
  return token;
}

describe("INT-02 interview scheduling", () => {
  beforeAll(async () => {
    [recruiterJwt, hrHeadJwt] = await Promise.all([signIn(RECRUITER), signIn(HR_HEAD)]);
    const claims = decodeJwt(recruiterJwt);
    tenantId = (claims as { tid?: string }).tid as string;
    const userId = claims.sub as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${userId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!m) throw new Error("recruiter membership missing");
    recruiterMembershipId = m.id;
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. upsertInterviewPlan replace-set + getInterviewPlan (by req + by application)", async () => {
    const two = await trpcMutation<{ roundCount: number }>(
      "upsertInterviewPlan",
      {
        requisitionId: I2_REQ,
        rounds: [
          {
            roundNumber: 1,
            roundName: "Technical Screen",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: ["system_design"],
            defaultPanelMembershipIds: [recruiterMembershipId],
          },
          {
            roundNumber: 2,
            roundName: "Hiring Manager",
            durationMinutes: 45,
            mode: "onsite",
            scorecardTemplate: "manager",
            competencyFocus: ["ownership"],
            defaultPanelMembershipIds: [],
          },
        ],
      },
      recruiterJwt,
    );
    assert.equal(data(two).roundCount, 2);

    const byReq = await trpcQuery<{ rounds: unknown[] }>(
      "getInterviewPlan",
      { requisitionId: I2_REQ },
      recruiterJwt,
    );
    assert.equal(data(byReq).rounds.length, 2);

    // Replace-set: one round replaces the previous two.
    const one = await trpcMutation<{ roundCount: number }>(
      "upsertInterviewPlan",
      {
        requisitionId: I2_REQ,
        rounds: [
          {
            roundNumber: 1,
            roundName: "Technical Screen",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: ["system_design"],
            defaultPanelMembershipIds: [recruiterMembershipId],
          },
        ],
      },
      recruiterJwt,
    );
    assert.equal(data(one).roundCount, 1);

    // Read the plan by applicationId (drawer path) — resolves the req.
    const byApp = await trpcQuery<{ requisitionId: string; rounds: unknown[] }>(
      "getInterviewPlan",
      { applicationId: I2_APP },
      recruiterJwt,
    );
    assert.equal(data(byApp).requisitionId, I2_REQ);
    assert.equal(data(byApp).rounds.length, 1);
  });

  it("2. scheduleInterview writes interview + panelists + hash + invitation", async () => {
    await resetSchedulingState();
    await ensurePlan();
    const res = await trpcMutation<{ interviewId: string; invitationSentTo: string | null }>(
      "scheduleInterview",
      {
        applicationId: I2_APP,
        roundNumber: 1,
        scheduledStart: futureStart(3),
        panelMembershipIds: [recruiterMembershipId],
        leadMembershipId: recruiterMembershipId,
        meetingUrl: "https://meet.example.com/int02",
      },
      recruiterJwt,
    );
    const out = data(res);
    assert.equal(out.invitationSentTo, "priya.int02@example.com");

    const [iv] = await poolSql<
      { status: string; confirm_signed_link_token_hash: string | null; mode: string }[]
    >`SELECT status, confirm_signed_link_token_hash, mode FROM public.interviews WHERE id = ${out.interviewId}`;
    assert.equal(iv?.status, "scheduled");
    assert.equal(iv?.mode, "video");
    assert.equal(iv?.confirm_signed_link_token_hash?.length, 64);

    const panel = await poolSql<{ is_lead: boolean }[]>`
      SELECT is_lead FROM public.interview_panelists WHERE interview_id = ${out.interviewId}
    `;
    assert.equal(panel.length, 1);
    assert.equal(panel[0]?.is_lead, true);

    const notif = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ${I2_CANDIDATE}
        AND template_key = 'candidate.interview_invitation'
    `;
    assert.equal(notif[0]?.n, 1);
  });

  it("2b. cross-member panel validates via service role (INT-04 discovery regression)", async () => {
    // assertActiveMemberships used to run under caller RLS, where
    // tenant_user_memberships is self-select-only — so paneling any OTHER
    // member spuriously failed BAD_REQUEST. Fixed to a service-role read
    // with an explicit tenant filter; this test pins it.
    await resetSchedulingState();
    await ensurePlan();
    const [other] = await poolSql<{ id: string }[]>`
      SELECT tum.id FROM public.tenant_user_memberships tum
      JOIN auth.users u ON u.id = tum.user_id
      WHERE tum.tenant_id = ${tenantId} AND u.email = 'panel1@kyndryl-poc.test'
    `;
    assert.ok(other?.id, "panel1 membership must exist (seed-test-users)");
    const res = await trpcMutation<{ interviewId: string }>(
      "scheduleInterview",
      {
        applicationId: I2_APP,
        roundNumber: 1,
        scheduledStart: futureStart(3),
        panelMembershipIds: [recruiterMembershipId, other.id],
        leadMembershipId: recruiterMembershipId,
      },
      recruiterJwt,
    );
    const panel = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.interview_panelists
      WHERE interview_id = ${data(res).interviewId}
    `;
    assert.equal(panel[0]?.n, 2);
  });

  it("3. Double-schedule the same round → CONFLICT", async () => {
    await resetSchedulingState();
    await ensurePlan();
    const first = await trpcMutation(
      "scheduleInterview",
      {
        applicationId: I2_APP,
        roundNumber: 1,
        scheduledStart: futureStart(3),
        panelMembershipIds: [recruiterMembershipId],
      },
      recruiterJwt,
    );
    data(first);
    const second = await trpcMutation(
      "scheduleInterview",
      {
        applicationId: I2_APP,
        roundNumber: 1,
        scheduledStart: futureStart(4),
        panelMembershipIds: [recruiterMembershipId],
      },
      recruiterJwt,
    );
    assert.ok(
      isErr(second) && second.error.data.code === "CONFLICT",
      `expected CONFLICT: ${JSON.stringify(second)}`,
    );
  });

  it("4. rescheduleInterview cancels the old round + creates the replacement", async () => {
    await resetSchedulingState();
    await ensurePlan();
    const first = data(
      await trpcMutation<{ interviewId: string }>(
        "scheduleInterview",
        {
          applicationId: I2_APP,
          roundNumber: 1,
          scheduledStart: futureStart(3),
          panelMembershipIds: [recruiterMembershipId],
        },
        recruiterJwt,
      ),
    );
    const re = data(
      await trpcMutation<{ interviewId: string; cancelledInterviewId: string | null }>(
        "rescheduleInterview",
        {
          applicationId: I2_APP,
          roundNumber: 1,
          scheduledStart: futureStart(5),
          panelMembershipIds: [recruiterMembershipId],
        },
        recruiterJwt,
      ),
    );
    assert.equal(re.cancelledInterviewId, first.interviewId);
    assert.notEqual(re.interviewId, first.interviewId);

    const [oldRow] = await poolSql<
      { status: string }[]
    >`SELECT status FROM public.interviews WHERE id = ${first.interviewId}`;
    assert.equal(oldRow?.status, "cancelled");
    const [newRow] = await poolSql<
      { status: string }[]
    >`SELECT status FROM public.interviews WHERE id = ${re.interviewId}`;
    assert.equal(newRow?.status, "scheduled");
  });

  it("5. confirm route stamps candidate_confirmed_at; second use rejected", async () => {
    await resetSchedulingState();
    await ensurePlan();
    const scheduled = data(
      await trpcMutation<{ interviewId: string }>(
        "scheduleInterview",
        {
          applicationId: I2_APP,
          roundNumber: 1,
          scheduledStart: futureStart(3),
          panelMembershipIds: [recruiterMembershipId],
        },
        recruiterJwt,
      ),
    );
    const token = await extractConfirmToken();

    const preview = await app.request(`/api/interviews/confirm/${token}`, { method: "GET" });
    const previewBody = (await preview.json()) as { ok: boolean; roundName?: string };
    assert.ok(previewBody.ok, `preview failed: ${JSON.stringify(previewBody)}`);
    assert.equal(previewBody.roundName, "Technical Screen");

    const confirm = await app.request(`/api/interviews/confirm/${token}`, { method: "POST" });
    const confirmBody = (await confirm.json()) as { ok: boolean };
    assert.ok(confirmBody.ok, `confirm failed: ${JSON.stringify(confirmBody)}`);

    const [row] = await poolSql<{ candidate_confirmed_at: string | null }[]>`
      SELECT candidate_confirmed_at FROM public.interviews WHERE id = ${scheduled.interviewId}
    `;
    assert.ok(row?.candidate_confirmed_at, "candidate_confirmed_at not stamped");

    // Second use rejected.
    const again = await app.request(`/api/interviews/confirm/${token}`, { method: "POST" });
    assert.equal(again.status, 409);
    const againBody = (await again.json()) as { ok: boolean; reason?: string };
    assert.equal(againBody.ok, false);
    assert.equal(againBody.reason, "already_confirmed");

    // The confirmed round is visible on the recruiter list with the badge.
    const list = data(
      await trpcQuery<{ rows: { id: string; candidateConfirmedAt: string | null }[] }>(
        "listUpcomingInterviews",
        { status: "scheduled" },
        recruiterJwt,
      ),
    );
    const found = list.rows.find((r) => r.id === scheduled.interviewId);
    assert.ok(found, "scheduled interview not in listUpcomingInterviews");
    assert.ok(found.candidateConfirmedAt, "confirmed badge state missing on list row");
  });

  it("6. hr_head (no manage role) is FORBIDDEN from scheduling + plan editing", async () => {
    const schedule = await trpcMutation(
      "scheduleInterview",
      {
        applicationId: I2_APP,
        roundNumber: 1,
        scheduledStart: futureStart(3),
        panelMembershipIds: [recruiterMembershipId],
      },
      hrHeadJwt,
    );
    assert.ok(
      isErr(schedule) && schedule.error.data.code === "FORBIDDEN",
      "hr_head schedule forbidden",
    );

    const upsert = await trpcMutation(
      "upsertInterviewPlan",
      { requisitionId: I2_REQ, rounds: [] },
      hrHeadJwt,
    );
    assert.ok(
      isErr(upsert) && upsert.error.data.code === "FORBIDDEN",
      "hr_head plan edit forbidden",
    );
  });
});
