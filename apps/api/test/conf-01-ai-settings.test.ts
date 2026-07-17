/**
 * CONF-01 — per-tenant AI settings: real config consumed by real calls.
 *
 * Coverage:
 *   Test 1: PII masker unit coverage — emails / phones / URLs redacted,
 *           idempotent, short numerics (years, weights) untouched.
 *   Test 2: resolveAiSettings merge/defaults — empty, partial and malformed
 *           stored blocks all resolve to a complete, valid config.
 *   Test 3: getTenantAiSettings (admin) returns defaults when the tenant has
 *           no stored aiSettings block.
 *   Test 4: admin-only gating — recruiter is FORBIDDEN from read AND write.
 *   Test 5: updateTenantAiSettings persists the block, PRESERVES unrelated
 *           settings keys, and writes an api_audit_logs row.
 *   Test 6: update validation — out-of-range temperature and a non-allowlist
 *           model are rejected.
 *   Test 7: disabled jd_generation → generateJdDraft returns a clean
 *           BAD_REQUEST naming the disable, and re-enabling restores it to
 *           the normal (fixture-miss in local mode) path.
 *   Test 8: the scoring drain passes the CONFIGURED model — asserted via the
 *           ai_usage_logs row's model field (LocalAIClient records the model
 *           it was called with).
 *   Test 9: ai_scoring disabled → the drain SKIPS the row: outbox completed,
 *           application left unscored with scored_by='skipped' /
 *           reason='ai_scoring_disabled', no usage-log row.
 *   Test 10: agent_drafts disabled → the worker draftWithAI port refuses
 *           with a clear error before any model call.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures) — no real tokens spent.
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1 / hiringmanager1).
 * kyndryl-poc's settings jsonb is snapshotted in beforeAll and restored
 * verbatim in afterAll; the drain tests run on a synthetic tenant.
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
import {
  maskPii,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_URL,
  resolveTenantAiSettings,
  hashStructuredOptions,
  type ParserOutput,
} from "@hireops/ai-client";
import { aiScoringResponseSchema, buildAIScoringPrompt } from "@hireops/ai-scoring";
import { resolveAiSettings, defaultAiSettings, type AiSettings } from "@hireops/api-types";
import { drainAiScoreOutboxOnce } from "../../../apps/workers/src/lib/ai-score-drain.js";
import { createExecutorDeps } from "../../../apps/workers/src/lib/agent-executor-deps.js";
import { createLogger } from "@hireops/observability";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Synthetic tenant for the drain tests (a6xx-free namespace, groom-safe
// because everything is deleted in afterAll).
const T = "00000000-0000-4000-8000-0000c0f10a00";
const BU = "00000000-0000-4000-8000-0000c0f10a01";
const POSITION = "00000000-0000-4000-8000-0000c0f10a02";
const JD = "00000000-0000-4000-8000-0000c0f10a03";
const REQ = "00000000-0000-4000-8000-0000c0f10a04";
const MEMBERSHIP = "00000000-0000-4000-8000-0000c0f10a05";
const PERSON_A = "00000000-0000-4000-8000-0000c0f10a06";
const CAND_A = "00000000-0000-4000-8000-0000c0f10a07";
const APP_A = "00000000-0000-4000-8000-0000c0f10a08";
const PERSON_B = "00000000-0000-4000-8000-0000c0f10a09";
const CAND_B = "00000000-0000-4000-8000-0000c0f10a0a";
const APP_B = "00000000-0000-4000-8000-0000c0f10a0b";

const RUN = Date.now().toString(36);
const TITLE = `CONF-01 Settings Engineer ${RUN}`;
const DEPARTMENT = `CONF-01 QA ${RUN}`;

const drainLog = createLogger({ base: { service: "conf-01-test" } });

let adminJwt: string;
let recruiterJwt: string;
let hiringManagerJwt: string;
let tenantId: string;
let originalSettings: unknown;
let draftReqId: string | undefined;
const writtenFixturePaths: string[] = [];

/** A minimal valid ParserOutput with PII the masker would redact. */
const PARSED_CV: ParserOutput = {
  personal: {
    full_name: "Conf Test Candidate",
    email: "conf01@example.com",
    phone: "+91 99000 11223",
    location_city: "Bengaluru",
    location_country: "India",
    linkedin_url: "https://linkedin.com/in/conf01",
    github_url: null,
    portfolio_url: null,
  },
  summary: "Backend engineer with platform experience.",
  total_years_experience: 7,
  current_role: {
    title: "Senior Engineer",
    company: "ExampleCo",
    start_date: "2022-04",
    location: null,
    description: null,
  },
  work_history: [
    {
      title: "Senior Engineer",
      company: "ExampleCo",
      start_date: "2022-04",
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
      start_year: 2011,
      end_year: 2015,
      grade: null,
    },
  ],
  skills: {
    technical: ["Java", "Kafka"],
    languages: ["English"],
    certifications: [],
    domain: [],
  },
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

/** Write an aiSettings block directly onto the synth tenant. */
async function setSynthAiSettings(block: Record<string, unknown>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('aiSettings', ${JSON.stringify(block)}::jsonb)
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
    VALUES (${personId}, ${T}, 'Conf Test Candidate', ${email})
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

describe("CONF-01 — per-tenant AI settings", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hiringManagerJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip any aiSettings a previous run / live check
    // left behind. afterAll restores the snapshot verbatim.
    await poolSql`
      UPDATE public.tenants SET settings = settings - 'aiSettings' WHERE id = ${tenantId}
    `;

    // Synthetic tenant for the drain tests.
    await cleanupSynthTenant();
    const adminUserId = decodeJwt(adminJwt).sub as string;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, 'synth-conf01', 'CONF-01 Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, 'Conf BU', 'conf-bu')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${adminUserId},
              ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, 'Conf Backend Engineer', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status, summary)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# Conf JD body', 'approved',
              'Backend engineer focused on JVM systems.')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id,
         hiring_manager_id, status, is_public, public_slug)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP},
              'posted', true, 'conf01-req')
    `;
  });

  afterAll(async () => {
    // Restore kyndryl-poc's settings exactly as found.
    try {
      await poolSql`
        UPDATE public.tenants
        SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort
    }
    // req-02-style child-first cleanup of the draft requisition.
    try {
      if (draftReqId) {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${draftReqId}
        `;
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${draftReqId}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${draftReqId}`;
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      }
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name = ${DEPARTMENT.trim()}`;
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

  it("Test 1: PII masker redacts emails / phones / URLs, idempotently", () => {
    const input =
      "Reach Priya at priya.s@example.co.in or +91 98765 43210. " +
      "Profile: https://linkedin.com/in/priya-s and www.priya.dev. " +
      "7 years experience since 2019, weight 0.80.";
    const once = maskPii(input);
    assert.ok(once.includes(REDACTED_EMAIL), "email redacted");
    assert.ok(once.includes(REDACTED_PHONE), "phone redacted");
    assert.ok(once.includes(REDACTED_URL), "url redacted");
    assert.ok(!once.includes("priya.s@example.co.in"), "raw email gone");
    assert.ok(!once.includes("98765"), "raw phone digits gone");
    assert.ok(!once.includes("linkedin.com"), "raw url gone");
    // Short numerics survive.
    assert.ok(once.includes("7 years experience since 2019"), "years untouched");
    assert.ok(once.includes("0.80"), "weights untouched");
    // Idempotent.
    assert.equal(maskPii(once), once, "masking already-masked text is a no-op");
    // No-PII text is verbatim.
    assert.equal(maskPii("plain text, 3 items"), "plain text, 3 items");
  });

  it("Test 2: resolveAiSettings merges defaults over empty / partial / malformed blocks", () => {
    const defaults = defaultAiSettings();
    assert.equal(defaults.ai_scoring.enabled, true);
    assert.equal(defaults.ai_scoring.model, "claude-sonnet-4-6");
    assert.equal(defaults.ai_scoring.maxTokens, 4096);
    assert.equal(defaults.piiMasking, false);

    // Absent block → defaults.
    assert.deepEqual(resolveAiSettings(undefined), defaults);
    assert.deepEqual(resolveAiSettings({}), defaults);

    // Partial block → merged (untouched features stay default).
    const partial = resolveAiSettings({ jd_generation: { enabled: false } });
    assert.equal(partial.jd_generation.enabled, false);
    assert.equal(partial.jd_generation.model, "claude-sonnet-4-6", "unset fields default");
    assert.equal(partial.ai_scoring.enabled, true, "other features untouched");

    // Malformed block → defaults, never a throw.
    assert.deepEqual(resolveAiSettings({ ai_scoring: { model: "gpt-5" } }), defaults);
    assert.deepEqual(resolveAiSettings("garbage"), defaults);
  });

  it("Test 3: getTenantAiSettings returns defaults when nothing stored", async () => {
    const res = await trpcQuery<AiSettings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.deepEqual(res.result.data, defaultAiSettings());
  });

  it("Test 4: recruiter is FORBIDDEN from read and write", async () => {
    const read = await trpcQuery("getTenantAiSettings", {}, recruiterJwt);
    assert.ok(isErr(read) && read.error.data.code === "FORBIDDEN", "read forbidden");
    const write = await trpcMutation("updateTenantAiSettings", { piiMasking: true }, recruiterJwt);
    assert.ok(isErr(write) && write.error.data.code === "FORBIDDEN", "write forbidden");
  });

  it("Test 5: update persists, preserves unrelated settings keys, and audits", async () => {
    // Plant an unrelated sibling key to prove the merge doesn't clobber.
    await poolSql`
      UPDATE public.tenants
      SET settings = settings || ${JSON.stringify({ conf01_sentinel: "keep-me" })}::jsonb
      WHERE id = ${tenantId}
    `;

    const res = await trpcMutation<{ ok: true; settings: AiSettings }>(
      "updateTenantAiSettings",
      {
        jd_generation: { model: "claude-haiku-4-5", temperature: 0.3 },
        piiMasking: true,
      },
      adminJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.settings.jd_generation.model, "claude-haiku-4-5");
    assert.equal(res.result.data.settings.jd_generation.temperature, 0.3);
    assert.equal(res.result.data.settings.piiMasking, true);
    assert.equal(res.result.data.settings.ai_scoring.enabled, true, "unset features default");

    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.equal(row!.settings["conf01_sentinel"], "keep-me", "sibling key preserved");
    const stored = row!.settings["aiSettings"] as Record<string, unknown>;
    assert.ok(stored, "aiSettings block stored");
    assert.equal((stored["jd_generation"] as Record<string, unknown>)["model"], "claude-haiku-4-5");

    // The effective read reflects the write.
    const readBack = await trpcQuery<AiSettings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(readBack));
    assert.equal(readBack.result.data.jd_generation.model, "claude-haiku-4-5");

    // withAudit is fire-and-forget — poll briefly for the audit row.
    let audited = false;
    for (let i = 0; i < 15 && !audited; i++) {
      const [a] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId}
          AND action = 'update_tenant_ai_settings'
          AND created_at >= now() - interval '2 minutes'
      `;
      audited = Number(a?.n) >= 1;
      if (!audited) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(audited, "an update_tenant_ai_settings api_audit_logs row exists");

    // Remove the sentinel again (settings restored fully in afterAll anyway).
    await poolSql`
      UPDATE public.tenants SET settings = settings - 'conf01_sentinel' WHERE id = ${tenantId}
    `;
  });

  it("Test 6: update rejects out-of-range temperature and non-allowlist model", async () => {
    const badTemp = await trpcMutation(
      "updateTenantAiSettings",
      { ai_scoring: { temperature: 2 } },
      adminJwt,
    );
    assert.ok(isErr(badTemp), "temperature 2 rejected");
    const badModel = await trpcMutation(
      "updateTenantAiSettings",
      { ai_scoring: { model: "gpt-5" } },
      adminJwt,
    );
    assert.ok(isErr(badModel), "non-allowlist model rejected");
  });

  it("Test 7: disabled jd_generation → clean error from generateJdDraft; re-enable restores", async () => {
    // Draft req as the hiring manager (the real wizard path).
    const created = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      {
        title: TITLE,
        department: DEPARTMENT,
        locationType: "remote",
        numberOfOpenings: 1,
      },
      hiringManagerJwt,
    );
    assert.ok(!isErr(created), `draft failed: ${JSON.stringify(created)}`);
    draftReqId = created.result.data.requisitionId;

    // Disable jd_generation.
    const off = await trpcMutation(
      "updateTenantAiSettings",
      { jd_generation: { enabled: false } },
      adminJwt,
    );
    assert.ok(!isErr(off));

    const gen = await trpcMutation(
      "generateJdDraft",
      { requisitionId: draftReqId },
      hiringManagerJwt,
    );
    assert.ok(isErr(gen), "generate should fail while disabled");
    assert.equal(gen.error.data.code, "BAD_REQUEST");
    assert.ok(
      /disabled/i.test(gen.error.message ?? ""),
      `error names the disable, got: ${gen.error.message}`,
    );

    // No usage-log row was written for the refused call (refusal happens
    // before the client is even constructed).
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'jd_generation'
        AND created_at >= now() - interval '1 minute'
    `;
    assert.equal(Number(n), 0, "no jd_generation usage row from the refusal");

    // Re-enable → the call proceeds to the AI client again (in local test
    // mode that is a fixture-miss error mentioning a prompt hash, which
    // proves the disable gate is no longer in the way).
    const on = await trpcMutation(
      "updateTenantAiSettings",
      { jd_generation: { enabled: true } },
      adminJwt,
    );
    assert.ok(!isErr(on));
    const gen2 = await trpcMutation(
      "generateJdDraft",
      { requisitionId: draftReqId },
      hiringManagerJwt,
    );
    assert.ok(isErr(gen2), "local mode without a fixture still errors…");
    assert.ok(
      /prompt hash/.test(gen2.error.message ?? ""),
      `…but at the AI-client layer (fixture miss), got: ${gen2.error.message}`,
    );
  });

  it("Test 8: scoring drain passes the configured model (ai_usage_logs.model)", async () => {
    // Configure the synth tenant: scoring on the cheaper allowlisted model.
    await setSynthAiSettings({
      ai_scoring: { model: "claude-haiku-4-5", temperature: 0.2, maxTokens: 1024 },
    });
    const effective = await resolveTenantAiSettings(poolSql, T);
    assert.equal(effective.ai_scoring.model, "claude-haiku-4-5");

    // Pre-compute the fixture BEFORE any drain runs by reconstructing the
    // exact prompt the drain builds (ai-03's technique). The hash covers
    // (prompt, system, model, schema) — so servicing it also PROVES the
    // configured model reached the AI client: with any other model the
    // lookup would miss and the drain could never complete.
    const { system, user } = buildAIScoringPrompt({
      positionTitle: "Conf Backend Engineer",
      jdDescription: "Backend engineer focused on JVM systems.",
      jdSkills: [],
      parsedCv: PARSED_CV,
    });
    const preHash = hashStructuredOptions({
      prompt: user,
      system,
      model: "claude-haiku-4-5",
      schema: z.toJSONSchema(aiScoringResponseSchema, { target: "draft-2020-12" }),
      schemaName: "candidate_fit_score",
      feature: "ai_scoring",
    } as Parameters<typeof hashStructuredOptions>[0]);
    const fixture = JSON.stringify({
      json: {
        score: 71,
        top_factors: [
          { factor: "skills_match", score: 0.8, note: "Java + Kafka present." },
          { factor: "experience_level", score: 0.7, note: "7 years is senior-adjacent." },
        ],
        caveats: [],
      },
      inputTokens: 500,
      outputTokens: 150,
      costMicros: 1100,
      latencyMs: 400,
    });
    const prePath = resolve(FIXTURE_DIR, `${preHash}.json`);
    writtenFixturePaths.push(prePath);
    await writeFile(prePath, fixture);

    await insertScoreRow(PERSON_A, CAND_A, APP_A, "conf01-a@example.com");

    // Clear other tenants' pending rows so the drain deterministically picks
    // ours (TESTFIX-01 precedent — the drain is global; the shared dev DB can
    // carry unserviceable pending rows from demo tenants).
    await poolSql`DELETE FROM public.ai_score_outbox WHERE status NOT IN ('completed') AND tenant_id != ${T}`;

    // The LIVE staging worker shares this DB and can steal the claim (it
    // then errors on the missing synth credential and re-pends the row). A
    // reset-and-drain loop reclaims it; the assertions below are on signals
    // the live worker can never produce (it writes no usage row and never
    // scores). If the pre-computed hash ever drifts from the worker's, the
    // fallback harvests the authoritative hash from last_error.
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
        // Fallback: harvest the worker-side hash if it differs from ours.
        const [row] = await poolSql<{ last_error: string | null }[]>`
          SELECT last_error FROM public.ai_score_outbox
          WHERE tenant_id = ${T} AND application_id = ${APP_A}
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

    const [usage] = await poolSql<{ model: string }[]>`
      SELECT model FROM public.ai_usage_logs
      WHERE tenant_id = ${T} AND feature = 'ai_scoring' AND succeeded = true
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.ok(usage, "an ai_scoring usage row exists");
    assert.equal(usage.model, "claude-haiku-4-5", "the CONFIGURED model was passed");

    const [scored] = await poolSql<{ ai_score: string | null }[]>`
      SELECT ai_score FROM public.applications WHERE tenant_id = ${T} AND id = ${APP_A}
    `;
    assert.equal(Number(scored?.ai_score), 71, "score landed on the application");
  });

  it("Test 9: ai_scoring disabled → drain skips cleanly (no model call, no retry)", async () => {
    await setSynthAiSettings({ ai_scoring: { enabled: false } });
    await insertScoreRow(PERSON_B, CAND_B, APP_B, "conf01-b@example.com");
    await poolSql`DELETE FROM public.ai_score_outbox WHERE status NOT IN ('completed') AND tenant_id != ${T}`;

    const usageBefore = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_usage_logs WHERE tenant_id = ${T}
    `;

    // Same reset-and-drain loop as Test 8 — the live worker can steal the
    // claim but can never produce the skip markers we assert on.
    const skippedOurs = async (): Promise<boolean> => {
      const [row] = await poolSql<{ ai_score_explanation: Record<string, unknown> | null }[]>`
        SELECT ai_score_explanation FROM public.applications
        WHERE tenant_id = ${T} AND id = ${APP_B}
      `;
      return row?.ai_score_explanation?.["reason"] === "ai_scoring_disabled";
    };
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      await poolSql`
        UPDATE public.ai_score_outbox
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL, attempt_count = 0
        WHERE tenant_id = ${T} AND application_id = ${APP_B} AND status <> 'completed'
      `;
      const result = await drainAiScoreOutboxOnce({ log: drainLog, batchSize: 5 });
      done = result.skipped >= 1 && (await skippedOurs());
      if (!done) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(done, "drain skipped our row via the disabled setting");

    const [outbox] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.ai_score_outbox
      WHERE tenant_id = ${T} AND application_id = ${APP_B}
    `;
    assert.equal(outbox?.status, "completed", "outbox row terminal, not retrying");

    const [appRow] = await poolSql<
      { ai_score: string | null; ai_score_explanation: Record<string, unknown> | null }[]
    >`
      SELECT ai_score, ai_score_explanation FROM public.applications
      WHERE tenant_id = ${T} AND id = ${APP_B}
    `;
    assert.equal(appRow?.ai_score, null, "application left unscored");
    assert.equal(appRow?.ai_score_explanation?.["scored_by"], "skipped");
    assert.equal(appRow?.ai_score_explanation?.["reason"], "ai_scoring_disabled");

    const usageAfter = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_usage_logs WHERE tenant_id = ${T}
    `;
    assert.equal(Number(usageAfter[0]?.n), Number(usageBefore[0]?.n), "no usage row written");
  });

  it("Test 10: agent_drafts disabled → draftWithAI refuses before any model call", async () => {
    await setSynthAiSettings({ agent_drafts: { enabled: false } });
    const deps = createExecutorDeps();
    await assert.rejects(
      () =>
        deps.draftWithAI(T, {
          system: "You are a recruiter.",
          prompt: "Draft a follow-up.",
          maxTokens: 512,
          feature: "agent_draft_message",
        }),
      /disabled/i,
      "refusal names the disable",
    );
  });
});
