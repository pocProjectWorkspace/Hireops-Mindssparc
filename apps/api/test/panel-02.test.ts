/**
 * PANEL-02 — panel brief enrichment + real-AI interview prep tests.
 *
 * Coverage:
 *   Test 1: computeSkillsMatch (pure) — exact/containment matching, weighted
 *           coverage %, empty-input edges.
 *   Test 2: getPanelInterviewBrief carries the deterministic skillsMatch +
 *           yearsOfExperience, and prior-round feedback exposes NO numeric
 *           scores (anti-anchoring).
 *   Test 3: generateInterviewPrep (LocalAI fixture) → interview_prep row
 *           cached + an interview_prep ai_usage_logs row; regenerate REPLACES
 *           (still one row); getInterviewPrep returns the cached card.
 *   Test 4: kill-switch — admin disables interview_prep → generate refuses
 *           (BAD_REQUEST, clean message) with NO ai_usage_logs delta;
 *           getInterviewPrep reports aiEnabled=false. Settings restored.
 *   Test 5: access control — a panel_member NOT on the interview gets
 *           FORBIDDEN from getInterviewPrep AND generateInterviewPrep; a
 *           recruiter (wrong role) gets FORBIDDEN from the panel surface.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures) — no real tokens are spent.
 * Requires `pnpm db:seed:test-users` (recruiter1 / panel1 / admin1 seeded).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { computeSkillsMatch } from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const PANEL = "panel1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";

// Fixed fixture ids (a202 namespace — PANEL-02 test rows, groom-safe cleanup).
const P2_BU = "00000000-0000-4000-8000-000000a20201";
const P2_POSITION = "00000000-0000-4000-8000-000000a20202";
const P2_JD = "00000000-0000-4000-8000-000000a20203";
const P2_REQ = "00000000-0000-4000-8000-000000a20204";
const P2_PERSON = "00000000-0000-4000-8000-000000a20205";
const P2_CANDIDATE = "00000000-0000-4000-8000-000000a20206";
const P2_APP = "00000000-0000-4000-8000-000000a20207";
const P2_IV1 = "00000000-0000-4000-8000-000000a20208"; // round 1 — recruiter's, completed (prior round)
const P2_IV2 = "00000000-0000-4000-8000-000000a20209"; // round 2 — panel1's round

const RUN = Date.now().toString(36);

let recruiterJwt: string;
let panelJwt: string;
let adminJwt: string;
let tenantId: string;
let recruiterMembershipId: string;
let panelMembershipId: string;
const writtenFixtures: string[] = [];

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
function data<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected tRPC error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}
function errCode<T>(e: TRPCSuccess<T> | TRPCErr): string {
  assert.ok(isErr(e), `expected tRPC error, got: ${JSON.stringify(e)}`);
  return (e as TRPCErr).error.data.code;
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

interface PrepCard {
  focusAreas: { title: string; why: string }[];
  probingQuestions: string[];
  model: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
}

/** Generate interview prep; on a LocalAI fixture miss, write a matching
 * fixture keyed by the harvested prompt hash and retry (hrops-02 technique). */
async function generateWithFixture(interviewId: string, jwt: string) {
  const first = await trpcMutation<{ prep: PrepCard }>(
    "generateInterviewPrep",
    { interviewId },
    jwt,
  );
  if (!isErr(first)) return first;
  const match = /prompt hash ([a-f0-9]{64})/.exec(first.error.message ?? "");
  assert.ok(match, `expected a prompt hash in the error, got: ${first.error.message}`);
  const path = resolve(FIXTURE_DIR, `${match[1]!}.json`);
  writtenFixtures.push(path);
  await writeFile(
    path,
    JSON.stringify({
      json: {
        focusAreas: [
          {
            title: "Distributed-system failure modes",
            why: "Round 1 flagged limited depth on failure modes; this round owns system design.",
          },
          {
            title: "Kafka operational experience",
            why: "Kafka is a must-have JD skill not evidenced in the parsed resume.",
          },
          {
            title: "Production incident ownership",
            why: "The JD asks for on-call ownership; probe the incident the candidate described.",
          },
        ],
        probingQuestions: [
          "Walk me through a cascading failure you have debugged end to end.",
          "How would you design idempotent consumers for an at-least-once queue?",
          "What trade-offs did you weigh when partitioning your last data model?",
          "Describe a time a rollout went wrong — what did you change afterwards?",
          "How do you decide between sync and async communication between services?",
          "What would you monitor first on a new high-throughput service?",
        ],
      },
      inputTokens: 900,
      outputTokens: 260,
      costMicros: 6100,
      latencyMs: 420,
    }),
  );
  return trpcMutation<{ prep: PrepCard }>("generateInterviewPrep", { interviewId }, jwt);
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.interview_prep WHERE interview_id IN (${P2_IV1}, ${P2_IV2})`,
    () =>
      poolSql`DELETE FROM public.interview_feedback WHERE interview_id IN (${P2_IV1}, ${P2_IV2})`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (${P2_IV1}, ${P2_IV2})`,
    () => poolSql`DELETE FROM public.interviews WHERE id IN (${P2_IV1}, ${P2_IV2})`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${P2_REQ}`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${P2_APP}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${P2_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${P2_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${P2_PERSON}`,
    () => poolSql`DELETE FROM public.jd_skills WHERE jd_version_id = ${P2_JD}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${P2_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${P2_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${P2_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${P2_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("PANEL-02 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${P2_BU}, ${tenantId}, ${`PANEL-02 QA ${RUN}`}, ${`panel02-qa-${RUN}`})
  `;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${P2_POSITION}, ${tenantId}, ${P2_BU}, ${`PANEL-02 Backend Engineer ${RUN}`}, 'hybrid', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${P2_JD}, ${tenantId}, ${P2_POSITION}, 1, '# PANEL-02 JD — backend engineer', 'approved')
  `;
  // JD skills: Python + PostgreSQL are in the parsed resume; Kafka is not.
  await poolSql`
    INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, weight, is_required)
    VALUES
      (${tenantId}, ${P2_JD}, 'Python', 2.00, true),
      (${tenantId}, ${P2_JD}, 'Kafka', 1.00, true),
      (${tenantId}, ${P2_JD}, 'PostgreSQL', 1.00, false)
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${P2_REQ}, ${tenantId}, ${P2_POSITION}, ${P2_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${P2_PERSON}, ${tenantId}, 'PANEL-02 Test Candidate', 'panel02-cand@example.test', 'panel02-cand@example.test', 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates
      (id, tenant_id, person_id, source, consent_version, parsed_skills, years_of_experience)
    VALUES (${P2_CANDIDATE}, ${tenantId}, ${P2_PERSON}, 'career_site', 'v1',
            ${JSON.stringify(["Python", "PostgreSQL", "Docker"])}::jsonb, 6.5)
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${P2_APP}, ${tenantId}, ${P2_CANDIDATE}, ${P2_REQ}, 'career_site', 'tech_interview', now())
  `;

  // Plan: round 1 technical, round 2 technical (system design focus).
  await poolSql`
    INSERT INTO public.interview_plans
      (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode, scorecard_template, competency_focus)
    VALUES
      (${tenantId}, ${P2_REQ}, 1, 'Technical Screen', 60, 'video', 'technical', ${JSON.stringify(["coding"])}::jsonb),
      (${tenantId}, ${P2_REQ}, 2, 'System Design', 60, 'video', 'technical', ${JSON.stringify(["system_design"])}::jsonb)
  `;

  // R1 — recruiter's round, completed, WITH submitted scored feedback (the
  // prior-round disclosure source; scores must NOT cross to R2's brief).
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode, created_by_membership_id)
    VALUES
      (${P2_IV1}, ${tenantId}, ${P2_APP}, ${P2_REQ}, 1, 'Technical Screen', 'completed',
       'technical', now() - interval '2 days', now() - interval '2 days' + interval '60 minutes',
       60, 'video', ${recruiterMembershipId})
  `;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${P2_IV1}, ${recruiterMembershipId}, true)
  `;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, strengths, concerns, recommendation, submitted_at)
    VALUES (${tenantId}, ${P2_IV1}, ${recruiterMembershipId},
       ${JSON.stringify({ problem_solving: 4, technical_depth: 5, code_quality: 4, system_design: 3, communication: 4 })}::jsonb,
       'Strong coding fundamentals', 'Light on failure-mode thinking', 'yes', now() - interval '1 day')
  `;

  // R2 — panel1's round (the brief + prep under test).
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode, created_by_membership_id)
    VALUES
      (${P2_IV2}, ${tenantId}, ${P2_APP}, ${P2_REQ}, 2, 'System Design', 'scheduled',
       'technical', now() + interval '390 days', now() + interval '390 days' + interval '60 minutes',
       60, 'video', ${recruiterMembershipId})
  `;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${P2_IV2}, ${panelMembershipId}, true)
  `;
}

interface BriefOut {
  candidate: { parsedSkills: string[]; yearsOfExperience: number | null };
  skillsMatch: {
    items: { skill: string; matched: boolean; isRequired: boolean; weight: number }[];
    matchedCount: number;
    totalCount: number;
    coveragePct: number;
  };
  priorRoundFeedback: Record<string, unknown>[];
}

describe("PANEL-02 panel brief + interview prep", () => {
  beforeAll(async () => {
    [recruiterJwt, panelJwt, adminJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(PANEL),
      signIn(ADMIN),
    ]);
    const rClaims = decodeJwt(recruiterJwt);
    const pClaims = decodeJwt(panelJwt);
    tenantId = (rClaims as { tid?: string }).tid as string;

    const [rm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${rClaims.sub as string} AND tenant_id = ${tenantId} LIMIT 1
    `;
    const [pm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${pClaims.sub as string} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!rm) throw new Error("recruiter membership missing");
    if (!pm) throw new Error("panel membership missing — run pnpm db:seed:test-users");
    recruiterMembershipId = rm.id;
    panelMembershipId = pm.id;

    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    for (const path of writtenFixtures) {
      try {
        await unlink(path);
      } catch {
        /* already gone */
      }
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: computeSkillsMatch is a pure deterministic overlap", () => {
    // Exact + containment matches, one miss; weighted coverage.
    const res = computeSkillsMatch(
      ["Python", "PostgreSQL", "AWS Lambda"],
      [
        { skillName: "Python", weight: 2, isRequired: true }, // exact
        { skillName: "Kafka", weight: 1, isRequired: true }, // miss
        { skillName: "AWS", weight: 1, isRequired: false }, // containment (AWS ⊂ AWS Lambda)
      ],
    );
    assert.equal(res.totalCount, 3);
    assert.equal(res.matchedCount, 2);
    // matched weight 3 of total 4 → 75%.
    assert.equal(res.coveragePct, 75);
    assert.deepEqual(
      res.items.map((i) => i.matched),
      [true, false, true],
    );

    // Case/punctuation insensitivity.
    const ci = computeSkillsMatch(
      ["node.js"],
      [{ skillName: "Node.JS", weight: 1, isRequired: true }],
    );
    assert.equal(ci.coveragePct, 100);

    // Empty JD skills → 0% with no items (honest empty state, no divide-by-zero).
    const empty = computeSkillsMatch(["Python"], []);
    assert.equal(empty.totalCount, 0);
    assert.equal(empty.coveragePct, 0);

    // Empty resume → nothing matches.
    const noResume = computeSkillsMatch([], [{ skillName: "Python", weight: 1, isRequired: true }]);
    assert.equal(noResume.matchedCount, 0);
    assert.equal(noResume.coveragePct, 0);
  });

  it("Test 2: brief carries skillsMatch + YoE; prior rounds expose NO numeric scores", async () => {
    const res = await trpcQuery<BriefOut>(
      "getPanelInterviewBrief",
      { interviewId: P2_IV2 },
      panelJwt,
    );
    const brief = data(res);

    // Deterministic skills match: Python (w2) + PostgreSQL (w1) matched, Kafka
    // (w1) missed → 3/4 weight = 75%.
    assert.equal(brief.skillsMatch.totalCount, 3);
    assert.equal(brief.skillsMatch.matchedCount, 2);
    assert.equal(brief.skillsMatch.coveragePct, 75);
    const kafka = brief.skillsMatch.items.find((i) => i.skill === "Kafka");
    assert.ok(kafka && !kafka.matched, "Kafka is the honest miss");

    // Parsed YoE surfaces for the experience card.
    assert.equal(brief.candidate.yearsOfExperience, 6.5);

    // ANTI-ANCHORING: the prior round is present with recommendation +
    // qualitative text and NOTHING numeric.
    assert.equal(brief.priorRoundFeedback.length, 1);
    const prior = brief.priorRoundFeedback[0]!;
    assert.equal(prior.recommendation, "yes");
    assert.equal(prior.strengths, "Strong coding fundamentals");
    assert.ok(!("scorecard" in prior), "prior-round feedback must not leak the scorecard");
    assert.ok(!("scores" in prior), "prior-round feedback must not leak scores");
    for (const [key, value] of Object.entries(prior)) {
      if (key === "roundNumber") continue; // ordinal metadata, not an assessment score
      assert.ok(typeof value !== "number", `prior-round field '${key}' must not be numeric`);
    }
  });

  it("Test 3: generateInterviewPrep caches + regenerate replaces + cost-logged", async () => {
    const res = await generateWithFixture(P2_IV2, panelJwt);
    assert.ok(!isErr(res), `generate: ${JSON.stringify(res)}`);
    const prep = res.result.data.prep;
    assert.ok(prep.focusAreas.length >= 1, "focus areas returned");
    assert.ok(prep.probingQuestions.length >= 1, "probing questions returned");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.interview_prep
      WHERE tenant_id = ${tenantId} AND interview_id = ${P2_IV2}
    `;
    assert.equal(Number(n), 1, "one interview_prep row cached");

    const [{ un } = { un: 0 }] = await poolSql<{ un: number }[]>`
      SELECT count(*)::int AS un FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'interview_prep' AND succeeded = true
    `;
    assert.ok(Number(un) >= 1, "a successful interview_prep ai_usage_logs row exists");

    // Regenerate → REPLACES (still exactly one row).
    const again = await generateWithFixture(P2_IV2, panelJwt);
    assert.ok(!isErr(again), `regenerate: ${JSON.stringify(again)}`);
    const [{ n2 } = { n2: 0 }] = await poolSql<{ n2: number }[]>`
      SELECT count(*)::int AS n2 FROM public.interview_prep
      WHERE tenant_id = ${tenantId} AND interview_id = ${P2_IV2}
    `;
    assert.equal(Number(n2), 1, "regenerate replaced the cached row");

    // Readable via getInterviewPrep (the cached card).
    const got = await trpcQuery<{ prep: PrepCard | null; aiEnabled: boolean }>(
      "getInterviewPrep",
      { interviewId: P2_IV2 },
      panelJwt,
    );
    const out = data(got);
    assert.ok(out.prep, "cached prep readable");
    assert.equal(out.aiEnabled, true);
    assert.equal(out.prep!.promptVersion, "panel-02-v1");
  });

  it("Test 4: kill-switch — disabled interview_prep refuses cleanly, no usage-log delta", async () => {
    interface Settings {
      [k: string]: unknown;
      interview_prep: { enabled: boolean };
    }
    const current = await trpcQuery<Settings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(current), `getTenantAiSettings: ${JSON.stringify(current)}`);
    const original = current.result.data;

    const [{ before } = { before: 0 }] = await poolSql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'interview_prep'
    `;

    const disabled = {
      ...original,
      interview_prep: { ...original.interview_prep, enabled: false },
    };
    const off = await trpcMutation("updateTenantAiSettings", disabled, adminJwt);
    assert.ok(!isErr(off), `disable: ${JSON.stringify(off)}`);

    try {
      const refused = await trpcMutation(
        "generateInterviewPrep",
        { interviewId: P2_IV2 },
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
        WHERE tenant_id = ${tenantId} AND feature = 'interview_prep'
      `;
      assert.equal(Number(after), Number(before), "no usage log written while disabled");

      // The read surface reports the honest disabled state.
      const got = await trpcQuery<{ aiEnabled: boolean }>(
        "getInterviewPrep",
        { interviewId: P2_IV2 },
        panelJwt,
      );
      assert.equal(data(got).aiEnabled, false);
    } finally {
      const restore = await trpcMutation("updateTenantAiSettings", original, adminJwt);
      assert.ok(!isErr(restore), `restore settings: ${JSON.stringify(restore)}`);
    }
  });

  it("Test 5: access control — non-panelist FORBIDDEN on prep read + generate; wrong role FORBIDDEN", async () => {
    // panel1 is NOT on R1 (the recruiter's round) → FORBIDDEN both ways.
    const read = await trpcQuery("getInterviewPrep", { interviewId: P2_IV1 }, panelJwt);
    assert.equal(errCode(read), "FORBIDDEN");

    const gen = await trpcMutation("generateInterviewPrep", { interviewId: P2_IV1 }, panelJwt);
    assert.equal(errCode(gen), "FORBIDDEN");

    // recruiter1 (no panel_member role) is outside the panel surface entirely.
    const wrongRole = await trpcQuery("getInterviewPrep", { interviewId: P2_IV2 }, recruiterJwt);
    assert.equal(errCode(wrongRole), "FORBIDDEN");
  });
});
