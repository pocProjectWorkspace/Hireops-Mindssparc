/**
 * PC-6 / PC-4 — evidence-based CV screening, integration.
 *
 * REQUIRES migration 0124 (application_screening_evidence) on the target DB.
 * NODE_ENV=test forces LocalAIClient — every model response comes from a
 * fixture written here (prompt-hash keyed); no live model is ever called.
 *
 * Drain (synthetic tenant, groom-safe — all rows deleted in afterAll):
 *   1. Drain scores the tenant's queued applications through the fixture
 *      client: score on the application, verified evidence stored (prompt
 *      version, model, fingerprint), a fabricated quote DROPPED and its met
 *      verdict DOWNGRADED to unclear; full JD reached the model (PP6).
 *   2. Concurrency is respected: 5 queued rows, concurrency 2 → all 5 claimed
 *      in one pass, never more than 2 in flight.
 *   3. Criteria change → requeueStaleScreeningEvidence flips evidence to
 *      'stale' and re-queues live applications (not a withdrawn one); the
 *      next drain re-generates against the new criteria (back to 'done').
 * Reads (kyndryl-poc / recruiter1, like polish-01):
 *   4. screeningScoreVisible=false → getCandidateById and
 *      listCandidatesByRequisition OMIT aiScore (and factor sub-scores) but
 *      carry the evidence; the group carries the queue depth.
 *   5. screeningScoreVisible=true → aiScore present again; listCandidates
 *      evidence_desc orders by the evidence key.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { resolveAiSettings } from "@hireops/api-types";
import { hashStructuredOptions, resetAIClientCache, type ParserOutput } from "@hireops/ai-client";
import {
  AI_SCORING_PROMPT_VERSION,
  aiScoringResponseSchema,
  buildAIScoringPrompt,
  buildScreeningCriteria,
  composeScreeningJd,
} from "@hireops/ai-scoring";
import {
  currentCriteriaFingerprint,
  drainAiScoreOutboxOnce,
  requeueStaleScreeningEvidence,
} from "../../../apps/workers/src/lib/ai-score-drain.js";
import { createLogger } from "@hireops/observability";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";

// Synthetic drain tenant — its own namespace (…0c6e…), deleted in afterAll.
const D = "00000000-0000-4000-8000-0000c6e0";
const T = `${D}0a00`;
const BU = `${D}0a01`;
const POSITION = `${D}0a02`;
const JD = `${D}0a03`;
const REQ = `${D}0a04`;
const MEMBERSHIP = `${D}0a05`;
const N_APPS = 5;
const person = (i: number) => `${D}0b0${i}`;
const cand = (i: number) => `${D}0c0${i}`;
const appId = (i: number) => `${D}0d0${i}`;

// Read-test rows inside kyndryl-poc (polish-01 pattern).
const R = "00000000-0000-4000-8000-0000c6e1";
const R_BU = `${R}0a01`;
const R_POS = `${R}0a02`;
const R_JD = `${R}0a03`;
const R_REQ = `${R}0a04`;
const R_PERSON_A = `${R}0b01`;
const R_CAND_A = `${R}0c01`;
const R_APP_A = `${R}0d01`;
const R_PERSON_B = `${R}0b02`;
const R_CAND_B = `${R}0c02`;
const R_APP_B = `${R}0d02`;

const JD_TAIL = "PC6-JD-TAIL-MARKER: must be able to travel to the Pune plant quarterly.";
// Longer than the old 500-char cut, with the marker at the very end (PP6).
const JD_TEXT = `# Finance Manager\n\n${"Own the month-end close across entities. ".repeat(20)}\n\n${JD_TAIL}`;
const JD_SUMMARY = "Finance manager owning month-end close and IFRS reporting.";
const JD_META = { sections: { requirements: ["Chartered Accountant (CA) qualification"] } };

const drainLog = createLogger({ base: { service: "pc6-test" } });
const writtenFixturePaths: string[] = [];

const PARSED_CV: ParserOutput = {
  personal: {
    full_name: "PC6 Test Candidate",
    email: "pc6@example.com",
    phone: null,
    location_city: "Pune",
    location_country: "India",
    linkedin_url: null,
    github_url: null,
    portfolio_url: null,
  },
  summary: "Chartered accountant with 8 years in month-end close and IFRS reporting.",
  total_years_experience: 8,
  current_role: {
    title: "Finance Manager",
    company: "ExampleChem",
    start_date: "2021-04",
    location: null,
    description: null,
  },
  work_history: [
    {
      title: "Finance Manager",
      company: "ExampleChem",
      start_date: "2021-04",
      end_date: null,
      location: null,
      description: "Led the month-end close for 3 entities using SAP S/4HANA.",
      employment_type: "full_time",
    },
  ],
  education: [],
  skills: {
    technical: ["SAP S/4HANA", "Excel"],
    languages: ["English"],
    certifications: [{ name: "Chartered Accountant", issuer: "ICAI", year: 2015 }],
    domain: ["IFRS"],
  },
  notice_period_days: 60,
  expected_compensation: null,
  parse_metadata: {
    parser_version: "1.0.0",
    parsed_at: "2026-11-01T00:00:00.000Z",
    confidence_score: 0.9,
    source_format: "docx",
    parser_model: "local",
  },
};

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
async function trpcQuery<O>(name: string, input: unknown, jwt: string): Promise<O> {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = (await res.json()) as TRPCSuccess<O> | TRPCErr;
  assert.ok(!("error" in body), `tRPC ${name} failed: ${JSON.stringify(body)}`);
  return (body as TRPCSuccess<O>).result.data;
}

/** The exact prompt the drain builds for PARSED_CV on REQ, given its skills. */
function expectedHash(skills: { skillName: string; weight: number; isRequired: boolean }[]) {
  const criteria = buildScreeningCriteria({
    jdSkills: skills,
    jdRequirements: JD_META.sections.requirements,
  });
  const { system, user } = buildAIScoringPrompt({
    positionTitle: "PC6 Finance Manager",
    jdDescription: composeScreeningJd(JD_TEXT, JD_SUMMARY),
    jdSkills: skills,
    parsedCv: PARSED_CV,
    criteria,
  });
  return {
    user,
    criteria,
    hash: hashStructuredOptions({
      prompt: user,
      system,
      model: resolveAiSettings({}).ai_scoring.model,
      schema: z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" }),
      schemaName: "candidate_fit_score",
      feature: "ai_scoring",
    } as Parameters<typeof hashStructuredOptions>[0]),
  };
}

async function writeFixture(hash: string, json: unknown): Promise<void> {
  const p = resolve(FIXTURE_DIR, `${hash}.json`);
  writtenFixturePaths.push(p);
  await writeFile(
    p,
    JSON.stringify({
      json,
      inputTokens: 3000,
      outputTokens: 900,
      costMicros: 15000,
      latencyMs: 40,
    }),
  );
}

/**
 * Drain T's rows until `done()` holds. The shared dev DB has a live staging
 * worker that can steal a claim (conf-01 precedent); resetting T's
 * not-completed rows to pending and re-draining reclaims them.
 */
async function drainUntil(
  done: () => Promise<boolean>,
  opts: { concurrency: number; batchSize: number },
): Promise<Awaited<ReturnType<typeof drainAiScoreOutboxOnce>>[]> {
  const passes: Awaited<ReturnType<typeof drainAiScoreOutboxOnce>>[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    passes.push(
      await drainAiScoreOutboxOnce({
        log: drainLog,
        ...opts,
        onlyTenantId: T,
        staleSweep: false,
      }),
    );
    if (await done()) return passes;
    await poolSql`
      UPDATE public.ai_score_outbox
      SET status = 'pending', claimed_by = NULL, claimed_at = NULL, attempt_count = 0
      WHERE tenant_id = ${T} AND status <> 'completed'
    `;
    await new Promise((r) => setTimeout(r, 250));
  }
  return passes;
}

async function cleanupDrainTenant(): Promise<void> {
  await poolSql`DELETE FROM public.application_screening_evidence WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.jd_skills WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;
}

let recruiterJwt: string;
let readTenantId: string;
let recruiterMembershipId: string;
let originalReadTenantSettings: unknown;

async function cleanupReadRows(): Promise<void> {
  const apps = [R_APP_A, R_APP_B];
  await poolSql`DELETE FROM public.application_screening_evidence WHERE application_id = ANY(${apps}::uuid[])`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE application_id = ANY(${apps}::uuid[])`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${apps}::uuid[])`;
  await poolSql`DELETE FROM public.applications WHERE id = ANY(${apps}::uuid[])`;
  await poolSql`DELETE FROM public.candidates WHERE id IN (${R_CAND_A}, ${R_CAND_B})`;
  await poolSql`DELETE FROM public.persons WHERE id IN (${R_PERSON_A}, ${R_PERSON_B})`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${R_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${R_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${R_POS}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${R_BU}`;
}

describe("PC-6 / PC-4 — evidence-based screening", () => {
  beforeAll(async () => {
    resetAIClientCache();
    recruiterJwt = await signIn(RECRUITER);
    const claims = decodeJwt(recruiterJwt) as { sub: string; tid: string };
    readTenantId = claims.tid;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${claims.sub} AND tenant_id = ${readTenantId} LIMIT 1`;
    if (!m) throw new Error("recruiter membership missing — run pnpm db:seed:test-users");
    recruiterMembershipId = m.id;
    const [t] = await poolSql<{ settings: unknown }[]>`
      SELECT settings FROM public.tenants WHERE id = ${readTenantId}`;
    originalReadTenantSettings = t?.settings ?? {};

    // ── synthetic drain tenant ──
    await cleanupDrainTenant();
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, 'synth-pc6', 'PC-6 Synth', 'ap-northeast-1', 'active')`;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, 'PC6 BU', 'pc6-bu')`;
    await poolSql`
      INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${claims.sub}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, 'PC6 Finance Manager', 'onsite', true)`;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status, summary, ai_metadata)
      VALUES (${JD}, ${T}, ${POSITION}, 1, ${JD_TEXT}, 'approved', ${JD_SUMMARY}, ${JSON.stringify(JD_META)}::jsonb)`;
    await poolSql`
      INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, weight, is_required)
      VALUES (${T}, ${JD}, 'SAP', 1.00, true),
             (${T}, ${JD}, 'IFRS', 0.80, true),
             (${T}, ${JD}, 'Excel', 0.30, false)`;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public, public_slug)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true, 'pc6-req')`;
    for (let i = 1; i <= N_APPS; i++) {
      await poolSql`
        INSERT INTO public.persons (id, tenant_id, full_name, email_primary)
        VALUES (${person(i)}, ${T}, ${`PC6 Candidate ${i}`}, ${`pc6-${i}@example.com`})`;
      await poolSql`
        INSERT INTO public.candidates (id, tenant_id, person_id, source, parsed_skills)
        VALUES (${cand(i)}, ${T}, ${person(i)}, 'career_site', ${JSON.stringify(PARSED_CV)}::jsonb)`;
      await poolSql`
        INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage)
        VALUES (${appId(i)}, ${T}, ${cand(i)}, ${REQ}, 'career_site', 'recruiter_review')`;
    }

    // ── read rows inside the recruiter's tenant ──
    await cleanupReadRows();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${R_BU}, ${readTenantId}, 'PC6 Read BU', 'pc6-read-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${R_POS}, ${readTenantId}, ${R_BU}, 'PC6 Read Role', 'hybrid', true)`;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${R_JD}, ${readTenantId}, ${R_POS}, 1, '# JD', 'approved')`;
    await poolSql`
      INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${R_REQ}, ${readTenantId}, ${R_POS}, ${R_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')`;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${R_PERSON_A}, ${readTenantId}, 'PC6 Read A', 'pc6-read-a@example.com', 'pc6-read-a@example.com'),
             (${R_PERSON_B}, ${readTenantId}, 'PC6 Read B', 'pc6-read-b@example.com', 'pc6-read-b@example.com')`;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
      VALUES (${R_CAND_A}, ${readTenantId}, ${R_PERSON_A}, 'career_site', 'v1', ${JSON.stringify(PARSED_CV)}::jsonb),
             (${R_CAND_B}, ${readTenantId}, ${R_PERSON_B}, 'career_site', 'v1', ${JSON.stringify(PARSED_CV)}::jsonb)`;
    const explanation = {
      scored_by: "local",
      model: "claude-sonnet-4-6",
      top_factors: [
        { factor: "skills_match", score: 0.9, note: "SAP + IFRS present." },
        { factor: "experience_level", score: 0.8, note: "8 years." },
      ],
      caveats: [],
      prompt_version: AI_SCORING_PROMPT_VERSION,
    };
    // A: higher score, WORSE evidence. B: lower score, BETTER evidence.
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at, ai_score, ai_score_explanation, ai_scored_at)
      VALUES
        (${R_APP_A}, ${readTenantId}, ${R_CAND_A}, ${R_REQ}, 'career_site', 'recruiter_review', now(), 88, ${JSON.stringify(explanation)}::jsonb, now()),
        (${R_APP_B}, ${readTenantId}, ${R_CAND_B}, ${R_REQ}, 'career_site', 'recruiter_review', now(), 61, ${JSON.stringify(explanation)}::jsonb, now())`;
    const crit = (verdict: string) => ({
      key: "mh-1",
      kind: "must_have",
      label: "SAP",
      verdict,
      reason: "r",
      quotes: verdict === "met" ? ["using SAP S/4HANA"] : [],
    });
    // The CURRENT fingerprint, so the (global) stale sweep in Test 3 leaves
    // these rows alone — they are up to date with R_REQ's criteria.
    const fp = await currentCriteriaFingerprint(readTenantId, R_APP_A);
    assert.ok(fp, "fingerprint resolves for the read application");
    await poolSql`
      INSERT INTO public.application_screening_evidence
        (tenant_id, application_id, status, criteria, criteria_count, met_count, partially_met_count,
         not_met_count, unclear_count, quotes_dropped, criteria_fingerprint, model, prompt_version, generated_at)
      VALUES
        (${readTenantId}, ${R_APP_A}, 'done', ${JSON.stringify([crit("not_met")])}::jsonb, 1, 0, 0, 1, 0, 0, ${fp}, 'local', ${AI_SCORING_PROMPT_VERSION}, now()),
        (${readTenantId}, ${R_APP_B}, 'done', ${JSON.stringify([crit("met")])}::jsonb, 1, 1, 0, 0, 0, 0, ${fp}, 'local', ${AI_SCORING_PROMPT_VERSION}, now())`;
    await poolSql`
      INSERT INTO public.ai_score_outbox (tenant_id, application_id, status)
      VALUES (${readTenantId}, ${R_APP_A}, 'completed'), (${readTenantId}, ${R_APP_B}, 'processing')`;
    // ('processing', not 'pending': the live staging worker drains this shared
    // DB and must not pick the row up mid-test. Both count as queued.)
  });

  afterAll(async () => {
    try {
      await poolSql`
        UPDATE public.tenants SET settings = ${JSON.stringify(originalReadTenantSettings ?? {})}::jsonb
        WHERE id = ${readTenantId}`;
    } catch {
      // best-effort
    }
    try {
      await cleanupReadRows();
      await cleanupDrainTenant();
    } catch (err) {
      console.warn("PC-6 cleanup failed (continuing):", err);
    }
    for (const p of writtenFixturePaths) {
      try {
        await unlink(p);
      } catch {
        // best-effort
      }
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: drain stores verified evidence with the score; fabricated quote dropped + downgraded; full JD sent", async () => {
    const skills = [
      { skillName: "SAP", weight: 1, isRequired: true },
      { skillName: "IFRS", weight: 0.8, isRequired: true },
      { skillName: "Excel", weight: 0.3, isRequired: false },
    ];
    const { user, criteria, hash } = expectedHash(skills);
    assert.deepEqual(
      criteria.map((c) => c.key),
      ["mh-1", "mh-2", "rq-1"],
    );
    assert.ok(user.includes(JD_TAIL), "the FULL JD reached the prompt (PP6)");
    await writeFixture(hash, {
      score: 74,
      top_factors: [
        { factor: "skills_match", score: 0.8, note: "SAP and IFRS present." },
        { factor: "experience_level", score: 0.7, note: "8 years." },
      ],
      caveats: [],
      criteria: [
        {
          criterion_key: "mh-1",
          verdict: "met",
          reason: "Uses SAP.",
          quotes: ["using SAP S/4HANA"],
        },
        {
          criterion_key: "mh-2",
          verdict: "met",
          reason: "IFRS.",
          quotes: ["Prepared IFRS consolidations for 12 group entities"],
        },
        {
          criterion_key: "rq-1",
          verdict: "partially_met",
          reason: "CA listed.",
          quotes: ["Chartered Accountant (ICAI, 2015)"],
        },
      ],
    });

    // Queue only 3 of the 5 for this test.
    for (let i = 1; i <= 3; i++) {
      await poolSql`INSERT INTO public.ai_score_outbox (tenant_id, application_id, status) VALUES (${T}, ${appId(i)}, 'pending')`;
    }
    const doneAll = async () => {
      const [r] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.application_screening_evidence WHERE tenant_id = ${T} AND status = 'done'`;
      return Number(r?.n) === 3;
    };
    const passes = await drainUntil(doneAll, { concurrency: 3, batchSize: 3 });
    assert.ok(await doneAll(), `3 evidence rows expected; passes=${JSON.stringify(passes)}`);

    const rows = await poolSql<
      {
        application_id: string;
        status: string;
        criteria: { key: string; verdict: string; quotes: string[]; reason: string }[];
        criteria_count: number;
        met_count: number;
        partially_met_count: number;
        not_met_count: number;
        unclear_count: number;
        quotes_dropped: number;
        prompt_version: string;
        model: string | null;
        criteria_fingerprint: string;
        ai_score: string | null;
      }[]
    >`
      SELECT e.*, a.ai_score
      FROM public.application_screening_evidence e
      JOIN public.applications a ON a.tenant_id = e.tenant_id AND a.id = e.application_id
      WHERE e.tenant_id = ${T} ORDER BY e.application_id`;
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(Number(r.ai_score), 74, "score still written (back-compat / ordering)");
      assert.equal(r.prompt_version, AI_SCORING_PROMPT_VERSION);
      assert.equal(r.model, resolveAiSettings({}).ai_scoring.model);
      assert.match(r.criteria_fingerprint, /^[a-f0-9]{32}$/);
      assert.equal(r.criteria_count, 3);
      assert.equal(r.met_count, 1);
      assert.equal(r.partially_met_count, 1);
      assert.equal(r.unclear_count, 1, "met with a fabricated quote → unclear");
      assert.equal(r.quotes_dropped, 1);
      const byKey = new Map(r.criteria.map((c) => [c.key, c]));
      assert.deepEqual(byKey.get("mh-1")?.quotes, ["using SAP S/4HANA"]);
      assert.equal(byKey.get("mh-2")?.verdict, "unclear");
      assert.deepEqual(byKey.get("mh-2")?.quotes, []);
      assert.equal(byKey.get("rq-1")?.verdict, "partially_met");
    }
  });

  it("Test 2: concurrency is respected — 5 rows, concurrency 2 → one pass claims 5, ≤2 in flight", async () => {
    await poolSql`
      UPDATE public.ai_score_outbox SET status = 'pending', attempt_count = 0, completed_at = NULL
      WHERE tenant_id = ${T}`;
    for (let i = 4; i <= N_APPS; i++) {
      await poolSql`INSERT INTO public.ai_score_outbox (tenant_id, application_id, status) VALUES (${T}, ${appId(i)}, 'pending')`;
    }
    const first = await drainAiScoreOutboxOnce({
      log: drainLog,
      concurrency: 2,
      batchSize: 5,
      onlyTenantId: T,
      staleSweep: false,
    });
    // The live staging worker could have stolen a row between our insert and
    // claim; whatever we claimed, never more than 2 ran at once.
    assert.ok(first.claimed >= 1 && first.claimed <= 5, JSON.stringify(first));
    assert.ok(first.peakConcurrency <= 2, `peak ${first.peakConcurrency} > 2`);
    if (first.claimed >= 2) assert.equal(first.peakConcurrency, 2);

    const doneAll = async () => {
      const [r] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.ai_score_outbox WHERE tenant_id = ${T} AND status = 'completed'`;
      return Number(r?.n) === N_APPS;
    };
    if (!(await doneAll())) await drainUntil(doneAll, { concurrency: 2, batchSize: 5 });
    assert.ok(await doneAll(), "all 5 rows completed");
    const [ev] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.application_screening_evidence WHERE tenant_id = ${T}`;
    assert.equal(Number(ev?.n), N_APPS, "one evidence row per application (upsert, no duplicates)");
  });

  it("Test 3: criteria change → evidence stale + re-queued (not a withdrawn application) → re-run is done", async () => {
    await poolSql`UPDATE public.applications SET current_stage = 'withdrawn' WHERE id = ${appId(5)}`;
    await poolSql`
      INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, weight, is_required)
      VALUES (${T}, ${JD}, 'Power BI', 0.60, true)`;

    const sweep = await requeueStaleScreeningEvidence();
    assert.ok(sweep.markedStale >= N_APPS, JSON.stringify(sweep));
    const states = await poolSql<{ application_id: string; ev: string; ob: string }[]>`
      SELECT e.application_id, e.status AS ev, o.status AS ob
      FROM public.application_screening_evidence e
      JOIN public.ai_score_outbox o ON o.tenant_id = e.tenant_id AND o.application_id = e.application_id
      WHERE e.tenant_id = ${T}`;
    for (const s of states) {
      assert.equal(s.ev, "stale");
      if (s.application_id === appId(5)) {
        assert.equal(s.ob, "completed", "withdrawn application is not re-queued");
      } else {
        assert.ok(["pending", "processing"].includes(s.ob), `re-queued, got ${s.ob}`);
      }
    }
    // Idempotent: a second sweep leaves T unchanged (nothing 'done' to flip,
    // re-queued rows are not 'completed' so are not re-queued again).
    await requeueStaleScreeningEvidence();
    const [doneLeft] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.application_screening_evidence
      WHERE tenant_id = ${T} AND status = 'done'`;
    assert.equal(Number(doneLeft?.n), 0);

    // New criteria → new prompt → new fixture.
    const skills = [
      { skillName: "SAP", weight: 1, isRequired: true },
      { skillName: "IFRS", weight: 0.8, isRequired: true },
      { skillName: "Power BI", weight: 0.6, isRequired: true },
      { skillName: "Excel", weight: 0.3, isRequired: false },
    ];
    const { criteria, hash } = expectedHash(skills);
    assert.deepEqual(
      criteria.map((c) => c.label),
      ["SAP", "IFRS", "Power BI", "Chartered Accountant (CA) qualification"],
    );
    await writeFixture(hash, {
      score: 70,
      top_factors: [
        { factor: "skills_match", score: 0.7, note: "No Power BI." },
        { factor: "other", score: 0.5, note: "-" },
      ],
      caveats: [],
      criteria: [
        { criterion_key: "mh-1", verdict: "met", reason: "SAP.", quotes: ["using SAP S/4HANA"] },
        { criterion_key: "mh-2", verdict: "met", reason: "IFRS.", quotes: ["IFRS reporting"] },
        { criterion_key: "mh-3", verdict: "not_met", reason: "No Power BI in the CV.", quotes: [] },
        { criterion_key: "rq-1", verdict: "met", reason: "CA.", quotes: ["Chartered Accountant"] },
      ],
    });
    const refreshed = async () => {
      const [r] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.application_screening_evidence
        WHERE tenant_id = ${T} AND status = 'done' AND criteria_count = 4`;
      return Number(r?.n) === N_APPS - 1;
    };
    await drainUntil(refreshed, { concurrency: 4, batchSize: 4 });
    assert.ok(await refreshed(), "the 4 live applications were re-screened against 4 criteria");
    const [w] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.application_screening_evidence WHERE application_id = ${appId(5)}`;
    assert.equal(w?.status, "stale", "the withdrawn application keeps its (flagged) old evidence");
    const [one] = await poolSql<{ met_count: number; not_met_count: number }[]>`
      SELECT met_count, not_met_count FROM public.application_screening_evidence WHERE application_id = ${appId(1)}`;
    assert.equal(one?.met_count, 3);
    assert.equal(one?.not_met_count, 1);
  });

  it("Test 4: screeningScoreVisible=false → aiScore omitted server-side; evidence + queue depth returned", async () => {
    await poolSql`
      UPDATE public.tenants
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
        'aiSettings', COALESCE(settings -> 'aiSettings', '{}'::jsonb) || '{"screeningScoreVisible": false}'::jsonb)
      WHERE id = ${readTenantId}`;

    const detail = await trpcQuery<{
      application: Record<string, unknown> & {
        aiScoreExplanation: { top_factors: Record<string, unknown>[] };
        screeningEvidence: { met: number; criteria: { quotes: string[] }[] } | null;
      };
    }>("getCandidateById", { id: R_CAND_B, applicationId: R_APP_B }, recruiterJwt);
    assert.ok(!("aiScore" in detail.application), "aiScore omitted from the detail output");
    assert.ok(
      detail.application.aiScoreExplanation.top_factors.every((f) => !("score" in f)),
      "factor sub-scores stripped",
    );
    assert.equal(detail.application.aiScoreExplanation.top_factors[0]?.note, "SAP + IFRS present.");
    assert.equal(detail.application.screeningEvidence?.met, 1);
    assert.deepEqual(detail.application.screeningEvidence?.criteria[0]?.quotes, [
      "using SAP S/4HANA",
    ]);

    const list = await trpcQuery<{
      groups: {
        requisitionId: string;
        screeningQueue: { pending: number; total: number };
        rows: (Record<string, unknown> & { applicationId: string })[];
      }[];
    }>(
      // PC-5 — the by-role list is paged largest-role-first, so on a busy
      // shared tenant this 2-application requisition may not be on page 1.
      // Filter to it, as the role picker does.
      "listCandidatesByRequisition",
      { requisitionId: R_REQ },
      recruiterJwt,
    );
    const g = list.groups.find((x) => x.requisitionId === R_REQ);
    assert.ok(g, "our requisition group is listed");
    assert.deepEqual(g.screeningQueue, { pending: 1, total: 2 });
    for (const r of g.rows) assert.ok(!("aiScore" in r), "aiScore omitted from list rows");
    // Hidden score → evidence order by default: B (1 met) before A (1 not met).
    assert.deepEqual(
      g.rows.map((r) => r.applicationId),
      [R_APP_B, R_APP_A],
    );
    assert.deepEqual(g.rows[0]?.evidenceSummary, {
      status: "done",
      criteriaCount: 1,
      met: 1,
      partiallyMet: 0,
      notMet: 0,
      unclear: 0,
    });

    const evidence = await trpcQuery<{ evidence: { criteria: unknown[] } | null }>(
      "getApplicationScreeningEvidence",
      { applicationId: R_APP_A },
      recruiterJwt,
    );
    assert.equal(evidence.evidence?.criteria.length, 1);
  });

  it("Test 5: screeningScoreVisible=true → aiScore present; score vs evidence order both available", async () => {
    await poolSql`
      UPDATE public.tenants
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
        'aiSettings', COALESCE(settings -> 'aiSettings', '{}'::jsonb) || '{"screeningScoreVisible": true}'::jsonb)
      WHERE id = ${readTenantId}`;

    const detail = await trpcQuery<{ application: { aiScore?: number | null } }>(
      "getCandidateById",
      { id: R_CAND_A, applicationId: R_APP_A },
      recruiterJwt,
    );
    assert.equal(detail.application.aiScore, 88);

    interface Rows {
      groups: { requisitionId: string; rows: { applicationId: string }[] }[];
    }
    const byScore = await trpcQuery<Rows>(
      "listCandidatesByRequisition",
      { requisitionId: R_REQ },
      recruiterJwt,
    );
    assert.deepEqual(
      byScore.groups.find((x) => x.requisitionId === R_REQ)?.rows.map((r) => r.applicationId),
      [R_APP_A, R_APP_B],
      "default order is the score while it is visible",
    );
    const byEvidence = await trpcQuery<Rows>(
      "listCandidatesByRequisition",
      { requisitionId: R_REQ, sort: "evidence" },
      recruiterJwt,
    );
    assert.deepEqual(
      byEvidence.groups.find((x) => x.requisitionId === R_REQ)?.rows.map((r) => r.applicationId),
      [R_APP_B, R_APP_A],
    );

    const triage = await trpcQuery<{ rows: { applicationId: string; aiScore?: number | null }[] }>(
      "listCandidates",
      {
        filters: { requisitionId: R_REQ },
        pagination: { limit: 10 },
        sort: "evidence_desc",
      },
      recruiterJwt,
    );
    assert.deepEqual(
      triage.rows.map((r) => r.applicationId),
      [R_APP_B, R_APP_A],
    );
    assert.equal(triage.rows[1]?.aiScore, 88);
  });
});
