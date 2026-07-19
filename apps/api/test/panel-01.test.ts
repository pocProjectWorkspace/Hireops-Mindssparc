/**
 * PANEL-01 — panel-member workboard API suite.
 *
 * Exercises the new panel surface over real cloud-minted JWTs (seeded
 * personas) against a self-seeded fixture: one application with TWO completed
 * interviews — IV1 with panel1 on the panel (no scorecard yet → pending +
 * overdue), IV2 with recruiter1's membership on the panel (NOT panel1's).
 *
 *   Test 1: getPanelDashboard (panel1) — pending is MINE ONLY (IV1 present +
 *           overdue, IV2 absent); recruiter (no panel_member role) FORBIDDEN.
 *   Test 2: mandatory notes — submit without notes → BAD_REQUEST ("Add
 *           detailed notes"); with notes + recommendation the submit lands and
 *           the pending queue drains / submitted list gains the row.
 *   Test 3: feedback_summary kill-switch — admin disables the feature →
 *           summarizeMyFeedbackNotes refuses (BAD_REQUEST, "disabled") with NO
 *           ai_usage_logs delta; settings restored.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures) — no real tokens are spent.
 * Requires `pnpm db:seed:test-users` (panel1 / recruiter1 / admin1).
 * Cleans up its own rows in afterAll.
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
const PANEL = "panel1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";

// Fixed fixture ids (0ba1 namespace — PANEL-01 test rows, groom-safe cleanup).
const FX_BU = "00000000-0000-4000-8000-0000000ba101";
const FX_POSITION = "00000000-0000-4000-8000-0000000ba102";
const FX_JD = "00000000-0000-4000-8000-0000000ba103";
const FX_REQ = "00000000-0000-4000-8000-0000000ba104";
const FX_PERSON = "00000000-0000-4000-8000-0000000ba105";
const FX_CANDIDATE = "00000000-0000-4000-8000-0000000ba106";
const FX_APP = "00000000-0000-4000-8000-0000000ba107";
const FX_IV1 = "00000000-0000-4000-8000-0000000ba108"; // panel1's — pending + overdue
const FX_IV2 = "00000000-0000-4000-8000-0000000ba109"; // recruiter membership's — NOT panel1's

let panelJwt: string;
let recruiterJwt: string;
let adminJwt: string;
let tenantId: string;
let panelMembershipId: string;
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
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url =
    input === undefined
      ? `/trpc/${name}`
      : `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
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
  const steps: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.interview_feedback WHERE interview_id IN (${FX_IV1}, ${FX_IV2})`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (${FX_IV1}, ${FX_IV2})`,
    () => poolSql`DELETE FROM public.interviews WHERE id IN (${FX_IV1}, ${FX_IV2})`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${FX_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${FX_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${FX_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${FX_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${FX_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${FX_BU}`,
  ];
  for (const run of steps) {
    try {
      await run();
    } catch (err) {
      console.warn("PANEL-01 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${FX_BU}, ${tenantId}, 'PANEL-01 QA', 'panel01-qa')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${FX_POSITION}, ${tenantId}, ${FX_BU}, 'PANEL-01 Backend Engineer', 'hybrid', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${FX_JD}, ${tenantId}, ${FX_POSITION}, 1, '# PANEL-01 JD', 'approved')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${FX_REQ}, ${tenantId}, ${FX_POSITION}, ${FX_JD},
            ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${FX_PERSON}, ${tenantId}, 'PANEL-01 Test Candidate',
            'panel01-cand@example.test', 'panel01-cand@example.test')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${FX_CANDIDATE}, ${tenantId}, ${FX_PERSON}, 'career_site', 'v1')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${FX_APP}, ${tenantId}, ${FX_CANDIDATE}, ${FX_REQ}, 'career_site', 'tech_interview', now())
    ON CONFLICT (id) DO NOTHING
  `;
  // IV1 — panel1 on the panel, completed 2 days ago (→ pending + overdue).
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode,
       created_by_membership_id)
    VALUES (${FX_IV1}, ${tenantId}, ${FX_APP}, ${FX_REQ}, 1, 'PANEL-01 Tech Screen', 'completed',
            'technical', now() - interval '2 days',
            now() - interval '2 days' + interval '60 minutes', 60, 'video',
            ${recruiterMembershipId})
  `;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${FX_IV1}, ${panelMembershipId}, true)
  `;
  // IV2 — recruiter1's membership on the panel (NOT panel1's) — the mine-only
  // boundary: it must never appear on panel1's board.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode,
       created_by_membership_id)
    VALUES (${FX_IV2}, ${tenantId}, ${FX_APP}, ${FX_REQ}, 2, 'PANEL-01 Other Round', 'completed',
            'manager', now() - interval '3 days',
            now() - interval '3 days' + interval '45 minutes', 45, 'video',
            ${recruiterMembershipId})
  `;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${FX_IV2}, ${recruiterMembershipId}, true)
  `;
}

interface BoardOut {
  stats: { pendingFeedback: number; avgScoreGiven: number | null };
  pending: { interviewId: string; overdue: boolean; candidateName: string | null }[];
  submitted: { interviewId: string; recommendation: string | null; avgScore: number | null }[];
}

describe("PANEL-01 panel workboard", () => {
  beforeAll(async () => {
    [panelJwt, recruiterJwt, adminJwt] = await Promise.all([
      signIn(PANEL),
      signIn(RECRUITER),
      signIn(ADMIN),
    ]);
    const pClaims = decodeJwt(panelJwt);
    const rClaims = decodeJwt(recruiterJwt);
    tenantId = (pClaims as { tid?: string }).tid as string;
    const panelUserId = pClaims.sub as string;
    const recruiterUserId = rClaims.sub as string;
    const [pm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${panelUserId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    const [rm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${recruiterUserId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!pm || !rm) throw new Error("memberships missing — run pnpm db:seed:test-users");
    panelMembershipId = pm.id;
    recruiterMembershipId = rm.id;

    await cleanup(); // wipe residue from a prior aborted run
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: getPanelDashboard pending is mine-only; recruiter FORBIDDEN", async () => {
    const res = await trpcQuery<BoardOut>("getPanelDashboard", undefined, panelJwt);
    assert.ok(!isErr(res), `getPanelDashboard: ${JSON.stringify(res)}`);
    const board = res.result.data;

    const mine = board.pending.find((p) => p.interviewId === FX_IV1);
    assert.ok(mine, "IV1 (my panel, completed, unscored) is pending");
    assert.equal(mine!.overdue, true, "completed 2 days ago → overdue");
    assert.equal(mine!.candidateName, "PANEL-01 Test Candidate");
    assert.ok(
      !board.pending.some((p) => p.interviewId === FX_IV2),
      "IV2 (someone else's panel) must NOT be in MY pending",
    );
    assert.ok(
      !board.submitted.some((s) => s.interviewId === FX_IV2),
      "IV2 must NOT be in MY submitted either",
    );
    assert.ok(board.stats.pendingFeedback >= 1, "pending stat counts IV1");

    const forbidden = await trpcQuery("getPanelDashboard", undefined, recruiterJwt);
    assert.ok(
      isErr(forbidden) && forbidden.error.data.code === "FORBIDDEN",
      "recruiter (no panel_member role) cannot read the panel board",
    );
  });

  it("Test 2: submit without notes → BAD_REQUEST; with notes it lands", async () => {
    const noNotes = await trpcMutation(
      "saveInterviewFeedback",
      {
        interviewId: FX_IV1,
        scorecard: { problem_solving: 4, communication: 5 },
        strengths: "Sharp on fundamentals",
        concerns: null,
        notes: null,
        recommendation: "yes",
        action: "submit",
      },
      panelJwt,
    );
    assert.ok(isErr(noNotes), "submit without notes refused");
    assert.equal(noNotes.error.data.code, "BAD_REQUEST");
    assert.ok(
      (noNotes.error.message ?? "").includes("Add detailed notes"),
      `mandatory-notes message: ${noNotes.error.message}`,
    );

    // Whitespace-only notes are refused too (trim() is the server check).
    const blankNotes = await trpcMutation(
      "saveInterviewFeedback",
      {
        interviewId: FX_IV1,
        scorecard: { problem_solving: 4, communication: 5 },
        notes: "   ",
        recommendation: "yes",
        action: "submit",
      },
      panelJwt,
    );
    assert.ok(isErr(blankNotes) && blankNotes.error.data.code === "BAD_REQUEST");

    // With real notes + a recommendation, the submit lands…
    const ok = await trpcMutation<{ state: string; submittedAt: string | null }>(
      "saveInterviewFeedback",
      {
        interviewId: FX_IV1,
        scorecard: { problem_solving: 4, communication: 5 },
        strengths: "Sharp on fundamentals",
        concerns: "Limited distributed-systems exposure",
        notes:
          "Worked through the queue-design exercise methodically; would benefit from a systems round.",
        recommendation: "yes",
        action: "submit",
      },
      panelJwt,
    );
    assert.ok(!isErr(ok), `submit with notes: ${JSON.stringify(ok)}`);
    assert.equal(ok.result.data.state, "submitted");

    // …and the board reflects it: IV1 leaves pending, joins submitted with my
    // recommendation + scorecard mean ((4+5)/2 = 4.5).
    const res = await trpcQuery<BoardOut>("getPanelDashboard", undefined, panelJwt);
    assert.ok(!isErr(res));
    const board = res.result.data;
    assert.ok(!board.pending.some((p) => p.interviewId === FX_IV1), "IV1 drained from pending");
    const sub = board.submitted.find((s) => s.interviewId === FX_IV1);
    assert.ok(sub, "IV1 now in submitted");
    assert.equal(sub!.recommendation, "yes");
    assert.equal(sub!.avgScore, 4.5, "avg of my per-criterion scores");
  });

  it("Test 3: feedback_summary kill-switch refuses cleanly, no usage-log delta", async () => {
    interface Settings {
      [k: string]: unknown;
      feedback_summary: { enabled: boolean };
    }
    const current = await trpcQuery<Settings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(current), `getTenantAiSettings: ${JSON.stringify(current)}`);
    const original = current.result.data;
    assert.ok(original.feedback_summary, "feedback_summary registered in ai-settings");

    const [{ before } = { before: 0 }] = await poolSql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'feedback_summary'
    `;

    const disabled = {
      ...original,
      feedback_summary: { ...original.feedback_summary, enabled: false },
    };
    const off = await trpcMutation("updateTenantAiSettings", disabled, adminJwt);
    assert.ok(!isErr(off), `disable: ${JSON.stringify(off)}`);

    try {
      const refused = await trpcMutation(
        "summarizeMyFeedbackNotes",
        { interviewId: FX_IV1, strengths: "Strong fundamentals", concerns: null, notes: null },
        panelJwt,
      );
      assert.ok(isErr(refused), "disabled feature refuses");
      assert.equal(refused.error.data.code, "BAD_REQUEST");
      assert.ok(
        (refused.error.message ?? "").toLowerCase().includes("disabled"),
        `clean disabled message: ${refused.error.message}`,
      );
      const [{ after } = { after: 0 }] = await poolSql<{ after: number }[]>`
        SELECT count(*)::int AS after FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId} AND feature = 'feedback_summary'
      `;
      assert.equal(Number(after), Number(before), "no usage log written while disabled");
    } finally {
      const restore = await trpcMutation("updateTenantAiSettings", original, adminJwt);
      assert.ok(!isErr(restore), `restore settings: ${JSON.stringify(restore)}`);
    }
  });
});
