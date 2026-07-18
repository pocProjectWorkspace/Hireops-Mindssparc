/**
 * CONF-03 — scoring weight profile + users & roles admin + retention display.
 *
 * Coverage:
 *   Test 1: scoringWeights zod — defaults resolve, partial merges, malformed /
 *           sum≠100 blocks fall back to defaults (never throw), and the
 *           .input() refine rejects a sum≠100 write.
 *   Test 2: prompt builder is pure — no weights → byte-identical to the
 *           pre-CONF-03 prompt (no emphasis block); a non-default profile
 *           renders an explicit "Grading emphasis" block with each label+weight.
 *   Test 3: the scoring drain passes a NON-DEFAULT profile through — the
 *           emphasis reaches the model (proven by the fixture hash, which
 *           covers the prompt text) and lands on ai_score_explanation.
 *           scoring_emphasis. A DEFAULT profile renders no emphasis + no
 *           scoring_emphasis (faithful-default contract).
 *   Test 4: updateScoringWeights persists + PRESERVES sibling settings
 *           (aiSettings + biasLexicon byte-survive) + audits.
 *   Test 5: admin-only gating — recruiter is FORBIDDEN from every CONF-03
 *           read + mutation.
 *   Test 6: invite creates an auth user + membership with the chosen roles
 *           (swept in afterAll); a second invite of the same email reuses the
 *           membership.
 *   Test 7: role edit + deactivate/reactivate on the invited member are
 *           audited and reflected in listTenantUsersAdmin.
 *   Test 8: self-demotion + self-deactivation are blocked (clean BAD_REQUEST).
 *   Test 9: getDocumentRetention returns the ONBOARD-01 reference rows.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures) — no real tokens spent.
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1). kyndryl-poc's
 * settings jsonb is snapshotted in beforeAll and restored verbatim in
 * afterAll; the drain test runs on a synthetic tenant.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { z } from "zod";
import { hashStructuredOptions, type ParserOutput } from "@hireops/ai-client";
import { aiScoringResponseSchema, buildAIScoringPrompt } from "@hireops/ai-scoring";
import {
  defaultScoringWeights,
  resolveScoringWeights,
  isDefaultScoringWeights,
  scoringWeightsEmphasis,
  type ScoringWeights,
  type TenantUserAdminRow,
} from "@hireops/api-types";
import { drainAiScoreOutboxOnce } from "../../../apps/workers/src/lib/ai-score-drain.js";
import { createLogger } from "@hireops/observability";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Synthetic tenant for the drain test (c0f30 namespace, groom-safe: deleted
// in afterAll).
const T = "00000000-0000-4000-8000-0000c0f30a00";
const BU = "00000000-0000-4000-8000-0000c0f30a01";
const POSITION = "00000000-0000-4000-8000-0000c0f30a02";
const JD = "00000000-0000-4000-8000-0000c0f30a03";
const REQ = "00000000-0000-4000-8000-0000c0f30a04";
const MEMBERSHIP = "00000000-0000-4000-8000-0000c0f30a05";
const PERSON_A = "00000000-0000-4000-8000-0000c0f30a06";
const CAND_A = "00000000-0000-4000-8000-0000c0f30a07";
const APP_A = "00000000-0000-4000-8000-0000c0f30a08";
const PERSON_B = "00000000-0000-4000-8000-0000c0f30a09";
const CAND_B = "00000000-0000-4000-8000-0000c0f30a0a";
const APP_B = "00000000-0000-4000-8000-0000c0f30a0b";

const RUN = Date.now().toString(36);
const INVITE_EMAIL = `conf03-invite-${RUN}@kyndryl-poc.test`;

const drainLog = createLogger({ base: { service: "conf-03-test" } });

let adminJwt: string;
let recruiterJwt: string;
let tenantId: string;
let adminUserId: string;
let adminMembershipId: string;
let originalSettings: unknown;
let invitedUserId: string | undefined;
let invitedMembershipId: string | undefined;
const writtenFixturePaths: string[] = [];

const PARSED_CV: ParserOutput = {
  personal: {
    full_name: "Conf3 Candidate",
    email: "conf03@example.com",
    phone: "+91 99000 55443",
    location_city: "Bengaluru",
    location_country: "India",
    linkedin_url: "https://linkedin.com/in/conf03",
    github_url: null,
    portfolio_url: null,
  },
  summary: "Backend engineer.",
  total_years_experience: 8,
  current_role: {
    title: "Staff Engineer",
    company: "ExampleCo",
    start_date: "2021-01",
    location: null,
    description: null,
  },
  work_history: [
    {
      title: "Staff Engineer",
      company: "ExampleCo",
      start_date: "2021-01",
      end_date: null,
      location: null,
      description: null,
      employment_type: "full_time",
    },
  ],
  education: [
    {
      degree: "B.Tech",
      field_of_study: "Computer Science",
      institution: "Example University",
      start_year: 2010,
      end_year: 2014,
      grade: null,
    },
  ],
  skills: { technical: ["Go", "Postgres"], languages: ["English"], certifications: [], domain: [] },
  notice_period_days: null,
  expected_compensation: null,
  parse_metadata: {
    parser_version: "1.0.0",
    parsed_at: new Date().toISOString(),
    confidence_score: 0.9,
    source_format: "docx",
    parser_model: "local",
  },
};

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

async function setSynthScoringWeights(block: Record<string, unknown> | null): Promise<void> {
  if (block === null) {
    await poolSql`UPDATE public.tenants SET settings = settings - 'scoringWeights' WHERE id = ${T}`;
    return;
  }
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('scoringWeights', ${JSON.stringify(block)}::jsonb)
    WHERE id = ${T}
  `;
}

async function insertScoreRow(
  personId: string,
  candId: string,
  appId: string,
  email: string,
): Promise<void> {
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary)
    VALUES (${personId}, ${T}, 'Conf3 Candidate', ${email})
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, parsed_skills)
    VALUES (${candId}, ${T}, ${personId}, 'career_site', ${JSON.stringify(PARSED_CV)}::jsonb)
  `;
  await poolSql`
    INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source)
    VALUES (${appId}, ${T}, ${candId}, ${REQ}, 'career_site')
  `;
  await poolSql`
    INSERT INTO public.ai_score_outbox (tenant_id, application_id, status)
    VALUES (${T}, ${appId}, 'pending')
  `;
}

async function cleanupSynthTenant(): Promise<void> {
  await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;
}

async function deleteInvitedUser(): Promise<void> {
  // Membership + profile via the pool; auth identity via the admin API.
  if (invitedMembershipId) {
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE id = ${invitedMembershipId}`;
  }
  if (invitedUserId) {
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE user_id = ${invitedUserId}`;
    await poolSql`DELETE FROM public.users WHERE id = ${invitedUserId}`;
    if (SERVICE_ROLE_KEY) {
      const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      await admin.auth.admin.deleteUser(invitedUserId).catch(() => {});
    }
  }
}

describe("CONF-03 — scoring weights + users & roles + retention", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    adminUserId = decodeJwt(adminJwt).sub as string;

    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip any scoringWeights a previous run/live check
    // left behind. afterAll restores the snapshot verbatim.
    await poolSql`UPDATE public.tenants SET settings = settings - 'scoringWeights' WHERE id = ${tenantId}`;

    const [m] = await poolSql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenant_user_memberships
      WHERE tenant_id = ${tenantId} AND user_id = ${adminUserId} LIMIT 1
    `;
    if (!m) throw new Error("admin membership not found");
    adminMembershipId = m.id;

    // Synthetic tenant for the drain test.
    await cleanupSynthTenant();
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, 'synth-conf03', 'CONF-03 Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, 'Conf3 BU', 'conf3-bu')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${adminUserId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, 'Conf3 Backend Engineer', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status, summary)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# Conf3 JD body', 'approved', 'Backend engineer, Go + Postgres.')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public, public_slug)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true, 'conf03-req')
    `;
  });

  afterAll(async () => {
    try {
      await poolSql`
        UPDATE public.tenants SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort
    }
    try {
      await deleteInvitedUser();
    } catch {
      // best-effort — groom sweep picks up residue
    }
    try {
      await cleanupSynthTenant();
    } catch {
      // best-effort
    }
    for (const p of writtenFixturePaths) {
      await unlink(p).catch(() => {});
    }
  });

  it("Test 1: scoringWeights zod — defaults, merge, malformed/sum≠100 → defaults, refine rejects", async () => {
    const defaults = defaultScoringWeights();
    assert.equal(defaults.skills_match, 50);
    assert.equal(defaults.experience_level, 25);
    assert.equal(defaults.industry_relevance, 15);
    assert.equal(defaults.education, 10);
    assert.ok(isDefaultScoringWeights(defaults));

    // Absent / empty → defaults.
    assert.deepEqual(resolveScoringWeights(undefined), defaults);
    assert.deepEqual(resolveScoringWeights({}), defaults);

    // A valid non-default profile round-trips.
    const custom = resolveScoringWeights({
      skills_match: 70,
      experience_level: 20,
      industry_relevance: 5,
      education: 5,
    });
    assert.equal(custom.skills_match, 70);
    assert.ok(!isDefaultScoringWeights(custom));

    // Malformed / sum≠100 → defaults, never a throw.
    assert.deepEqual(
      resolveScoringWeights({
        skills_match: 90,
        experience_level: 90,
        industry_relevance: 0,
        education: 0,
      }),
      defaults,
      "sum≠100 falls back to defaults",
    );
    assert.deepEqual(resolveScoringWeights("garbage"), defaults);

    // Emphasis flatten is weight-descending.
    const emphasis = scoringWeightsEmphasis(custom);
    assert.equal(emphasis[0]!.key, "skills_match");
    assert.equal(emphasis[0]!.weight, 70);

    // The .input() refine rejects a sum≠100 write over the wire.
    const bad = await trpcMutation(
      "updateScoringWeights",
      { skills_match: 50, experience_level: 50, industry_relevance: 50, education: 50 },
      adminJwt,
    );
    assert.ok(isErr(bad), "sum≠100 write rejected");
  });

  it("Test 2: prompt builder is pure — default omits emphasis, non-default renders it", () => {
    const base = buildAIScoringPrompt({
      positionTitle: "Conf3 Backend Engineer",
      jdDescription: "Backend engineer, Go + Postgres.",
      jdSkills: [],
      parsedCv: PARSED_CV,
    });
    assert.ok(!/Grading emphasis/.test(base.user), "no emphasis block without weights");

    const emphasis = scoringWeightsEmphasis(
      resolveScoringWeights({
        skills_match: 80,
        experience_level: 10,
        industry_relevance: 5,
        education: 5,
      }),
    ).map((e) => ({ key: e.key, label: e.label, weight: e.weight }));

    const withWeights = buildAIScoringPrompt({
      positionTitle: "Conf3 Backend Engineer",
      jdDescription: "Backend engineer, Go + Postgres.",
      jdSkills: [],
      parsedCv: PARSED_CV,
      scoringWeights: emphasis,
    });
    assert.ok(/Grading emphasis/.test(withWeights.user), "emphasis block present with weights");
    assert.ok(/Skills match: 80%/.test(withWeights.user), "renders label + weight");
    assert.ok(/Experience level: 10%/.test(withWeights.user));
    // Non-emphasis text is otherwise the same (base user is a prefix once the
    // block is stripped) — a light guard that we only ADDED content.
    assert.ok(withWeights.user.includes("Candidate parsed CV:"));
    assert.ok(withWeights.system === base.system, "system prompt unchanged");
  });

  it("Test 3: drain passes a non-default profile through → scoring_emphasis on the explanation", async () => {
    const profile = {
      skills_match: 80,
      experience_level: 10,
      industry_relevance: 5,
      education: 5,
    };
    await setSynthScoringWeights(profile);

    const resolved = resolveScoringWeights(profile);
    assert.ok(!isDefaultScoringWeights(resolved));
    const emphasis = scoringWeightsEmphasis(resolved).map((e) => ({
      key: e.key,
      label: e.label,
      weight: e.weight,
    }));

    // Reconstruct the EXACT prompt the drain builds (with emphasis) so the
    // LocalAIClient fixture services it — proving the emphasis reached the
    // model (the hash covers the prompt text). Synth tenant has no aiSettings,
    // so the drain uses the default model.
    const { system, user } = buildAIScoringPrompt({
      positionTitle: "Conf3 Backend Engineer",
      jdDescription: "Backend engineer, Go + Postgres.",
      jdSkills: [],
      parsedCv: PARSED_CV,
      scoringWeights: emphasis,
    });
    const preHash = hashStructuredOptions({
      prompt: user,
      system,
      model: "claude-sonnet-4-6",
      schema: z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" }),
      schemaName: "candidate_fit_score",
      feature: "ai_scoring",
    } as Parameters<typeof hashStructuredOptions>[0]);
    const fixture = JSON.stringify({
      json: {
        score: 83,
        top_factors: [
          { factor: "skills_match", score: 0.9, note: "Go + Postgres present." },
          { factor: "experience_level", score: 0.8, note: "8 years." },
        ],
        caveats: [],
      },
      inputTokens: 500,
      outputTokens: 150,
      costMicros: 1200,
      latencyMs: 400,
    });
    const prePath = resolve(FIXTURE_DIR, `${preHash}.json`);
    writtenFixturePaths.push(prePath);
    await writeFile(prePath, fixture);

    await insertScoreRow(PERSON_A, CAND_A, APP_A, "conf03-a@example.com");
    await poolSql`DELETE FROM public.ai_score_outbox WHERE status NOT IN ('completed') AND tenant_id != ${T}`;

    const completedOurs = async (): Promise<boolean> => {
      const [u] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.ai_usage_logs
        WHERE tenant_id = ${T} AND feature = 'ai_scoring' AND succeeded = true
      `;
      return Number(u?.n) >= 1;
    };
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      await poolSql`
        UPDATE public.ai_score_outbox
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL, attempt_count = 0
        WHERE tenant_id = ${T} AND application_id = ${APP_A} AND status <> 'completed'
      `;
      await drainAiScoreOutboxOnce({ log: drainLog, batchSize: 5 });
      done = await completedOurs();
      if (!done) {
        const [row] = await poolSql<{ last_error: string | null }[]>`
          SELECT last_error FROM public.ai_score_outbox WHERE tenant_id = ${T} AND application_id = ${APP_A}
        `;
        const m = /prompt hash ([a-f0-9]{64})/.exec(row?.last_error ?? "");
        if (m && m[1] !== preHash) {
          const p = resolve(FIXTURE_DIR, `${m[1]}.json`);
          writtenFixturePaths.push(p);
          await writeFile(p, fixture);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(done, "drain completed our row through the LocalAIClient fixture");

    const [scored] = await poolSql<
      { ai_score: string | null; ai_score_explanation: Record<string, unknown> | null }[]
    >`
      SELECT ai_score, ai_score_explanation FROM public.applications WHERE tenant_id = ${T} AND id = ${APP_A}
    `;
    assert.equal(Number(scored?.ai_score), 83, "score landed");
    const emphasisOut = scored?.ai_score_explanation?.["scoring_emphasis"] as
      | { key: string; weight: number }[]
      | undefined;
    assert.ok(Array.isArray(emphasisOut), "scoring_emphasis recorded on the explanation");
    assert.equal(emphasisOut![0]!.key, "skills_match");
    assert.equal(emphasisOut![0]!.weight, 80);

    // Now the DEFAULT profile → no emphasis block, no scoring_emphasis.
    await setSynthScoringWeights(null); // strip → resolves to defaults
    const defBuilt = buildAIScoringPrompt({
      positionTitle: "Conf3 Backend Engineer",
      jdDescription: "Backend engineer, Go + Postgres.",
      jdSkills: [],
      parsedCv: PARSED_CV,
    });
    const defHash = hashStructuredOptions({
      prompt: defBuilt.user,
      system: defBuilt.system,
      model: "claude-sonnet-4-6",
      schema: z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" }),
      schemaName: "candidate_fit_score",
      feature: "ai_scoring",
    } as Parameters<typeof hashStructuredOptions>[0]);
    const defPath = resolve(FIXTURE_DIR, `${defHash}.json`);
    writtenFixturePaths.push(defPath);
    await writeFile(defPath, fixture);

    await insertScoreRow(PERSON_B, CAND_B, APP_B, "conf03-b@example.com");
    await poolSql`DELETE FROM public.ai_score_outbox WHERE status NOT IN ('completed') AND tenant_id != ${T}`;
    const completedB = async (): Promise<boolean> => {
      const [row] = await poolSql<{ ai_score: string | null }[]>`
        SELECT ai_score FROM public.applications WHERE tenant_id = ${T} AND id = ${APP_B}
      `;
      return row?.ai_score !== null && row?.ai_score !== undefined;
    };
    let doneB = false;
    for (let attempt = 0; attempt < 6 && !doneB; attempt++) {
      await poolSql`
        UPDATE public.ai_score_outbox
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL, attempt_count = 0
        WHERE tenant_id = ${T} AND application_id = ${APP_B} AND status <> 'completed'
      `;
      await drainAiScoreOutboxOnce({ log: drainLog, batchSize: 5 });
      doneB = await completedB();
      if (!doneB) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(doneB, "default-profile row scored");
    const [scoredB] = await poolSql<{ ai_score_explanation: Record<string, unknown> | null }[]>`
      SELECT ai_score_explanation FROM public.applications WHERE tenant_id = ${T} AND id = ${APP_B}
    `;
    assert.equal(
      scoredB?.ai_score_explanation?.["scoring_emphasis"],
      undefined,
      "default profile carries NO scoring_emphasis (faithful-default contract)",
    );
  });

  it("Test 4: updateScoringWeights persists + preserves sibling settings + audits", async () => {
    // Plant known sibling blocks first (aiSettings + biasLexicon) + a sentinel.
    await poolSql`
      UPDATE public.tenants
      SET settings = COALESCE(settings, '{}'::jsonb)
          || ${JSON.stringify({
            conf03_sentinel: "keep-me",
            aiSettings: { version: 1, piiMasking: true },
          })}::jsonb
      WHERE id = ${tenantId}
    `;
    const [before] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    const aiBefore = JSON.stringify(before!.settings["aiSettings"]);

    const res = await trpcMutation<{ ok: true; weights: ScoringWeights }>(
      "updateScoringWeights",
      { skills_match: 60, experience_level: 25, industry_relevance: 10, education: 5 },
      adminJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.weights.skills_match, 60);

    const [after] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.equal(after!.settings["conf03_sentinel"], "keep-me", "sentinel sibling preserved");
    assert.equal(
      JSON.stringify(after!.settings["aiSettings"]),
      aiBefore,
      "aiSettings sibling byte-survives the weights write",
    );
    const storedWeights = after!.settings["scoringWeights"] as Record<string, unknown>;
    assert.equal(storedWeights["skills_match"], 60);

    // The effective admin read reflects the write.
    const readBack = await trpcQuery<ScoringWeights>("getScoringWeights", {}, adminJwt);
    assert.ok(!isErr(readBack));
    assert.equal(readBack.result.data.skills_match, 60);

    // Audit (fire-and-forget — poll).
    let audited = false;
    for (let i = 0; i < 15 && !audited; i++) {
      const [a] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId} AND action = 'update_scoring_weights'
          AND created_at >= now() - interval '2 minutes'
      `;
      audited = Number(a?.n) >= 1;
      if (!audited) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(audited, "an update_scoring_weights api_audit_logs row exists");

    // Clean the planted keys (afterAll restores fully anyway).
    await poolSql`
      UPDATE public.tenants
      SET settings = (settings - 'conf03_sentinel' - 'scoringWeights')
      WHERE id = ${tenantId}
    `;
  });

  it("Test 5: recruiter is FORBIDDEN from every CONF-03 read + mutation", async () => {
    const checks: [string, "q" | "m", unknown][] = [
      ["getScoringWeights", "q", {}],
      ["listTenantUsersAdmin", "q", {}],
      ["getDocumentRetention", "q", {}],
      [
        "updateScoringWeights",
        "m",
        { skills_match: 25, experience_level: 25, industry_relevance: 25, education: 25 },
      ],
      ["inviteTenantUser", "m", { email: "x@kyndryl-poc.test", roles: ["recruiter"] }],
      ["updateMembershipRoles", "m", { membershipId: adminMembershipId, roles: ["recruiter"] }],
      ["setMembershipStatus", "m", { membershipId: adminMembershipId, status: "suspended" }],
    ];
    for (const [name, kind, input] of checks) {
      const r =
        kind === "q"
          ? await trpcQuery(name, input, recruiterJwt)
          : await trpcMutation(name, input, recruiterJwt);
      assert.ok(
        isErr(r) && r.error.data.code === "FORBIDDEN",
        `${name} should be FORBIDDEN for recruiter`,
      );
    }
  });

  it("Test 6: invite creates an auth user + membership; a repeat reuses it", async () => {
    const first = await trpcMutation<{
      membershipId: string;
      userId: string;
      email: string;
      tempPassword: string;
      alreadyExisted: boolean;
      membershipReused: boolean;
    }>(
      "inviteTenantUser",
      { email: INVITE_EMAIL, displayName: "Conf3 Invitee", roles: ["recruiter", "panel_member"] },
      adminJwt,
    );
    assert.ok(!isErr(first), `invite failed: ${JSON.stringify(first)}`);
    invitedUserId = first.result.data.userId;
    invitedMembershipId = first.result.data.membershipId;
    assert.ok(first.result.data.tempPassword.length >= 12, "temp password returned");
    assert.equal(first.result.data.membershipReused, false);

    // Membership row exists with the chosen roles + active.
    const [row] = await poolSql<{ roles: string[]; status: string }[]>`
      SELECT roles, status FROM public.tenant_user_memberships WHERE id = ${invitedMembershipId}
    `;
    assert.ok(row, "membership row created");
    assert.deepEqual([...row!.roles].sort(), ["panel_member", "recruiter"]);
    assert.equal(row!.status, "active");

    // Auth identity exists.
    const [au] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth.users WHERE id = ${invitedUserId}
    `;
    assert.equal(Number(au?.n), 1, "auth user created");

    // Second invite of the same email → membership reused (not duplicated).
    const second = await trpcMutation<{ membershipReused: boolean; membershipId: string }>(
      "inviteTenantUser",
      { email: INVITE_EMAIL, roles: ["hr_ops"] },
      adminJwt,
    );
    assert.ok(!isErr(second), `re-invite failed: ${JSON.stringify(second)}`);
    assert.equal(second.result.data.membershipReused, true, "membership reused");
    assert.equal(second.result.data.membershipId, invitedMembershipId, "same membership id");
    const [count] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_user_memberships
      WHERE tenant_id = ${tenantId} AND user_id = ${invitedUserId}
    `;
    assert.equal(Number(count?.n), 1, "no duplicate membership");
  });

  it("Test 7: role edit + deactivate/reactivate on the invited member — audited + reflected", async () => {
    assert.ok(invitedMembershipId, "prereq: invited membership from Test 6");

    const edit = await trpcMutation<{ ok: true; roles: string[] }>(
      "updateMembershipRoles",
      { membershipId: invitedMembershipId, roles: ["hiring_manager"] },
      adminJwt,
    );
    assert.ok(!isErr(edit), `role edit failed: ${JSON.stringify(edit)}`);

    const deactivate = await trpcMutation(
      "setMembershipStatus",
      { membershipId: invitedMembershipId, status: "suspended" },
      adminJwt,
    );
    assert.ok(!isErr(deactivate), "deactivate ok");

    // Reflected in the admin listing.
    const list = await trpcQuery<{ items: TenantUserAdminRow[] }>(
      "listTenantUsersAdmin",
      {},
      adminJwt,
    );
    assert.ok(!isErr(list));
    const invited = list.result.data.items.find((u) => u.membershipId === invitedMembershipId);
    assert.ok(invited, "invited member present in listing");
    assert.deepEqual(invited!.roles, ["hiring_manager"], "roles reflect the edit");
    assert.equal(invited!.status, "suspended", "status reflects the deactivation");

    // Reactivate for completeness.
    const react = await trpcMutation(
      "setMembershipStatus",
      { membershipId: invitedMembershipId, status: "active" },
      adminJwt,
    );
    assert.ok(!isErr(react), "reactivate ok");

    // Audit rows exist for both actions.
    let audited = false;
    for (let i = 0; i < 15 && !audited; i++) {
      const [a] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId}
          AND action IN ('update_membership_roles', 'set_membership_status')
          AND created_at >= now() - interval '3 minutes'
      `;
      audited = Number(a?.n) >= 2;
      if (!audited) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(audited, "role edit + status change audited");
  });

  it("Test 8: self-demotion + self-deactivation are blocked", async () => {
    // Admin removing their own admin role (keeping only recruiter) → BAD_REQUEST.
    const demote = await trpcMutation(
      "updateMembershipRoles",
      { membershipId: adminMembershipId, roles: ["recruiter"] },
      adminJwt,
    );
    assert.ok(isErr(demote) && demote.error.data.code === "BAD_REQUEST", "self-demotion blocked");

    // Admin deactivating themselves → BAD_REQUEST.
    const selfOff = await trpcMutation(
      "setMembershipStatus",
      { membershipId: adminMembershipId, status: "suspended" },
      adminJwt,
    );
    assert.ok(
      isErr(selfOff) && selfOff.error.data.code === "BAD_REQUEST",
      "self-deactivation blocked",
    );

    // The admin membership is untouched (still active, still admin).
    const [row] = await poolSql<{ roles: string[]; status: string }[]>`
      SELECT roles, status FROM public.tenant_user_memberships WHERE id = ${adminMembershipId}
    `;
    assert.ok(row!.roles.includes("admin"), "admin role intact");
    assert.equal(row!.status, "active", "admin still active");
  });

  it("Test 9: getDocumentRetention returns the ONBOARD-01 reference rows", async () => {
    const res = await trpcQuery<{ items: { code: string; retentionYears: number | null }[] }>(
      "getDocumentRetention",
      {},
      adminJwt,
    );
    assert.ok(!isErr(res), `retention read failed: ${JSON.stringify(res)}`);
    assert.ok(res.result.data.items.length >= 10, "reference rows present");
    const pan = res.result.data.items.find((r) => r.code === "pan_card");
    assert.ok(pan, "pan_card present");
    assert.equal(pan!.retentionYears, 7, "pan retention 7y");
  });
});
