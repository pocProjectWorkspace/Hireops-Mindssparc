/**
 * CONF-02 — JD bias lexicon + deterministic scanner + configurable submit gate.
 *
 * The honest inclusive-language layer over the requisition JD: a configurable
 * lexicon in tenants.settings.biasLexicon (sibling to CONF-01's aiSettings), a
 * pure isomorphic scanner, a warn-vs-block submit gate, and an optional
 * advisory AI review. NO demographic / fairness analysis anywhere.
 *
 *   Pure scanner (no DB):
 *     Test 1: whole-word boundaries (plurals / substrings don't match).
 *     Test 2: phrases match across arbitrary whitespace; single words too.
 *     Test 3: overlapping terms all reported; clean text yields nothing.
 *     Test 4: resolveBiasLexicon defaults (absent/partial/malformed) + the
 *             summarizeScan / scanBlocksSubmit semantics.
 *
 *   Over real cloud-minted JWTs (reality #110) on the kyndryl-poc tenant:
 *     Test 5: getBiasLexicon returns the seeded DEFAULT when nothing stored;
 *             recruiter may READ but is FORBIDDEN to WRITE.
 *     Test 6: updateTenantBiasLexicon persists, preserves sibling settings
 *             (aiSettings survives!), and audits.
 *     Test 7: block mode blocks submit with the offending terms + suggestions;
 *             the requisition stays a draft.
 *     Test 8: warn mode lets the submit through and records the flags into the
 *             approval context — the HR-head queue read exposes them.
 *     Test 9: off mode is silent — submit proceeds, no bias_scan recorded.
 *     Test 10: reviewJdWithAi refuses when jd_bias_review is disabled (no
 *              model call, no usage row); when enabled it returns observations
 *              and writes an ai_usage_logs row (feature jd_bias_review).
 *
 * NODE_ENV=test forces LocalAIClient (fixtures), so no real tokens are spent.
 * Requires `pnpm db:seed:test-users` (admin1 / hiringmanager1 / hrhead1 /
 * recruiter1). Restores the tenant settings + cleans its rows in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  scanJdText,
  resolveBiasLexicon,
  defaultBiasLexicon,
  defaultBiasEntries,
  summarizeScan,
  scanBlocksSubmit,
  type BiasLexiconEntry,
  type BiasLexicon,
} from "@hireops/api-types";

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
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE = `CONF-02 Bias Engineer ${RUN}`;
const DEPT_PREFIX = `CONF-02 QA ${RUN}`;

let adminJwt: string;
let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;
let tenantId: string;
let originalSettings: unknown;
const createdReqIds: string[] = [];
const writtenFixturePaths: string[] = [];
let draftCounter = 0;

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

/** Write a biasLexicon block directly onto the real tenant (service-role). */
async function setBiasLexicon(block: Record<string, unknown>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('biasLexicon', ${JSON.stringify(block)}::jsonb)
    WHERE id = ${tenantId}
  `;
}
async function setAiSettings(block: Record<string, unknown>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('aiSettings', ${JSON.stringify(block)}::jsonb)
    WHERE id = ${tenantId}
  `;
}
async function clearBiasSettings(): Promise<void> {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'biasLexicon' - 'aiSettings' WHERE id = ${tenantId}
  `;
}

/** Create a draft requisition whose JD summary is `summary`. Returns its id. */
async function createDraftWithJd(summary: string): Promise<string> {
  draftCounter += 1;
  const create = await trpcMutation<{ requisitionId: string }>(
    "createRequisitionDraft",
    {
      title: `${TITLE} ${draftCounter}`,
      department: `${DEPT_PREFIX} ${draftCounter}`,
      locationType: "remote",
    },
    hiringManagerJwt,
  );
  assert.ok(!isErr(create), `createRequisitionDraft failed: ${JSON.stringify(create)}`);
  const rid = create.result.data.requisitionId;
  createdReqIds.push(rid);
  const upd = await trpcMutation(
    "updateRequisitionDraft",
    {
      requisitionId: rid,
      sections: {
        summary,
        responsibilities: ["Design and ship reliable services.", "Own quality end to end."],
        requirements: ["Three or more years of relevant experience.", "Clear communication."],
      },
      skills: [{ skillName: "Kafka", weight: 1, isRequired: true }],
    },
    hiringManagerJwt,
  );
  assert.ok(!isErr(upd), `updateRequisitionDraft failed: ${JSON.stringify(upd)}`);
  return rid;
}

describe("CONF-02 — JD bias gate", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hiringManagerJwt, hrHeadJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
    ]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip any bias/ai blocks a previous run left behind.
    await clearBiasSettings();
  });

  afterAll(async () => {
    // Restore kyndryl-poc's settings exactly as found.
    try {
      await poolSql`
        UPDATE public.tenants SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort
    }
    // Child-first cleanup of every draft this run created.
    for (const rid of createdReqIds) {
      try {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${rid}
        `;
        await poolSql`DELETE FROM public.approval_requests WHERE subject_id = ${rid} AND tenant_id = ${tenantId}`;
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${rid}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${rid}`;
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      } catch {
        // best-effort — groom sweep picks up residue
      }
    }
    try {
      await poolSql`
        DELETE FROM public.business_units
        WHERE tenant_id = ${tenantId} AND name LIKE ${DEPT_PREFIX + "%"}
      `;
    } catch {
      // best-effort
    }
    for (const p of writtenFixturePaths) {
      await unlink(p).catch(() => {});
    }
  });

  // ─────────────── pure scanner (no DB) ───────────────

  it("Test 1: scanner matches whole words, not plurals or substrings", () => {
    const entries: BiasLexiconEntry[] = [
      { term: "rockstar", category: "superlative_pressure", severity: "block" },
    ];
    const hit = scanJdText("We want a Rockstar for this team.", entries);
    assert.equal(hit.length, 1, "one match (case-insensitive)");
    assert.equal(hit[0]!.matchedText, "Rockstar", "preserves author casing");
    assert.equal(hit[0]!.start, 10);
    assert.equal(scanJdText("rockstars welcome", entries).length, 0, "plural not matched");
    assert.equal(scanJdText("crockstart", entries).length, 0, "substring not matched");
  });

  it("Test 2: phrases match across whitespace; single words match too", () => {
    const entries: BiasLexiconEntry[] = [
      { term: "young and energetic", category: "age_coded", severity: "block" },
      { term: "energetic", category: "age_coded", severity: "warn" },
    ];
    const m = scanJdText("Seeking a young  and\nenergetic engineer.", entries);
    const terms = m.map((x) => x.term).sort();
    assert.deepEqual(terms, ["energetic", "young and energetic"], "phrase (\\s+) + single word");
  });

  it("Test 3: overlapping terms all reported; clean text yields nothing", () => {
    const entries: BiasLexiconEntry[] = [
      { term: "young and energetic", category: "age_coded", severity: "block" },
      { term: "young", category: "age_coded", severity: "block" },
      { term: "energetic", category: "age_coded", severity: "warn" },
    ];
    const m = scanJdText("A young and energetic hire.", entries);
    assert.equal(m.length, 3, "three overlapping matches");
    assert.equal(
      scanJdText("We build reliable payment systems with a focus on quality.", defaultBiasEntries())
        .length,
      0,
      "clean professional text has no matches",
    );
  });

  it("Test 4: resolveBiasLexicon defaults; summarize + block semantics", () => {
    const def = defaultBiasLexicon();
    assert.equal(def.enforcement, "warn", "default enforcement is warn");
    assert.ok(def.entries.length >= 40, "seeded default lexicon is substantial");
    assert.deepEqual(resolveBiasLexicon(undefined), def, "absent → defaults");
    assert.deepEqual(resolveBiasLexicon("garbage"), def, "malformed → defaults, never throws");
    const partial = resolveBiasLexicon({ enforcement: "block" });
    assert.equal(partial.enforcement, "block", "partial keeps its enforcement");
    assert.ok(partial.entries.length >= 40, "partial fills entries from default");

    const blockLex = resolveBiasLexicon({ enforcement: "block" });
    const blocked = summarizeScan("We need a rockstar ninja who is young.", blockLex);
    assert.ok(blocked.blockingCount >= 3, "rockstar + ninja + young are block-severity");
    assert.equal(scanBlocksSubmit(blocked), true, "block enforcement + block matches → gates");

    const warnLex = resolveBiasLexicon({ enforcement: "warn" });
    const warned = summarizeScan("We need a rockstar ninja who is young.", warnLex);
    assert.equal(scanBlocksSubmit(warned), false, "warn enforcement never gates");
    const off = summarizeScan("rockstar", resolveBiasLexicon({ enforcement: "off" }));
    assert.equal(scanBlocksSubmit(off), false, "off never gates");
  });

  // ─────────────── over HTTP on the real tenant ───────────────

  it("Test 5: getBiasLexicon returns the default; recruiter reads, cannot write", async () => {
    await clearBiasSettings();
    const read = await trpcQuery<BiasLexicon>("getBiasLexicon", {}, adminJwt);
    assert.ok(!isErr(read), `expected success, got ${JSON.stringify(read)}`);
    assert.equal(read.result.data.enforcement, "warn");
    assert.ok(read.result.data.entries.length >= 40, "default lexicon loaded when block absent");

    // Recruiter may READ (in the read-role set) but not WRITE.
    const recRead = await trpcQuery("getBiasLexicon", {}, recruiterJwt);
    assert.ok(!isErr(recRead), "recruiter may read the lexicon");
    const recWrite = await trpcMutation(
      "updateTenantBiasLexicon",
      { version: 1, enforcement: "warn", entries: defaultBiasEntries() },
      recruiterJwt,
    );
    assert.ok(
      isErr(recWrite) && recWrite.error.data.code === "FORBIDDEN",
      "recruiter write forbidden",
    );
  });

  it("Test 6: updateTenantBiasLexicon persists, preserves aiSettings sibling, and audits", async () => {
    // Plant an aiSettings sibling + a sentinel to prove the merge doesn't clobber.
    await setAiSettings({ jd_generation: { model: "claude-haiku-4-5" } });
    await poolSql`
      UPDATE public.tenants
      SET settings = settings || ${JSON.stringify({ conf02_sentinel: "keep-me" })}::jsonb
      WHERE id = ${tenantId}
    `;

    const custom = [
      {
        term: "rockstar",
        category: "superlative_pressure",
        severity: "block",
        suggestion: "Describe the role.",
      },
      { term: "wizard", category: "superlative_pressure", severity: "warn" },
    ];
    const res = await trpcMutation<{ ok: true; lexicon: BiasLexicon }>(
      "updateTenantBiasLexicon",
      { version: 1, enforcement: "block", entries: custom },
      adminJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.lexicon.enforcement, "block");
    assert.equal(res.result.data.lexicon.entries.length, 2);

    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.equal(row!.settings["conf02_sentinel"], "keep-me", "unrelated sibling preserved");
    const ai = row!.settings["aiSettings"] as Record<string, unknown>;
    assert.ok(ai, "aiSettings block survives the bias-lexicon write");
    assert.equal(
      (ai["jd_generation"] as Record<string, unknown>)["model"],
      "claude-haiku-4-5",
      "aiSettings content intact",
    );
    const stored = row!.settings["biasLexicon"] as Record<string, unknown>;
    assert.equal(stored["enforcement"], "block", "biasLexicon block stored");

    // withAudit is fire-and-forget — poll briefly for the audit row.
    let audited = false;
    for (let i = 0; i < 15 && !audited; i++) {
      const [a] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId} AND action = 'update_tenant_bias_lexicon'
      `;
      if (Number(a?.n ?? 0) > 0) audited = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(audited, "update_tenant_bias_lexicon audit row written");

    // Reset to the default lexicon for the gate tests below.
    await clearBiasSettings();
  });

  it("Test 7: block mode blocks the submit with the offending terms + suggestions", async () => {
    await setBiasLexicon({ enforcement: "block" }); // default entries → rockstar/ninja block
    const rid = await createDraftWithJd("We need a rockstar ninja to own the payments platform.");
    const res = await trpcMutation(
      "submitRequisitionForApproval",
      { requisitionId: rid },
      hiringManagerJwt,
    );
    assert.ok(isErr(res), `expected BAD_REQUEST, got ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "BAD_REQUEST");
    assert.match(res.error.message ?? "", /rockstar/i, "message names the blocking term");

    // The requisition stayed a draft — nothing was submitted.
    const [r] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${rid}
    `;
    assert.equal(r?.status, "draft", "blocked submit leaves the req a draft");
  });

  it("Test 8: warn mode submits and records the flags into the approval context (queue exposes them)", async () => {
    await setBiasLexicon({ enforcement: "warn" });
    const rid = await createDraftWithJd("We need a rockstar to own the payments platform.");
    const res = await trpcMutation<{ approvalRequestId: string; alreadySubmitted: boolean }>(
      "submitRequisitionForApproval",
      { requisitionId: rid },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);

    // The recorded context carries the scan.
    const [ar] = await poolSql<{ context: Record<string, unknown> }[]>`
      SELECT context FROM public.approval_requests
      WHERE subject_id = ${rid} AND tenant_id = ${tenantId} AND status = 'pending'
    `;
    const scan = ar?.context?.["bias_scan"] as Record<string, unknown> | undefined;
    assert.ok(scan, "bias_scan recorded in approval context");
    assert.equal((scan!["flags"] as unknown[]).length >= 1, true, "at least one flag recorded");

    // The HR-head queue read exposes the flags.
    const queue = await trpcQuery<{
      rows: Array<{ subjectId: string; biasFlags: Array<{ term: string }> }>;
    }>("listRequisitionApprovals", { limit: 100 }, hrHeadJwt);
    assert.ok(!isErr(queue), `queue read failed: ${JSON.stringify(queue)}`);
    const rowForReq = queue.result.data.rows.find((x) => x.subjectId === rid);
    assert.ok(rowForReq, "the submitted req is in the queue");
    assert.ok(
      rowForReq!.biasFlags.some((f) => f.term.toLowerCase() === "rockstar"),
      "queue exposes the rockstar flag to the HR head",
    );
  });

  it("Test 9: off mode is silent — submit proceeds, no bias_scan recorded", async () => {
    await setBiasLexicon({ enforcement: "off" });
    const rid = await createDraftWithJd("We need a rockstar to own the payments platform.");
    const res = await trpcMutation(
      "submitRequisitionForApproval",
      { requisitionId: rid },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const [ar] = await poolSql<{ context: Record<string, unknown> }[]>`
      SELECT context FROM public.approval_requests
      WHERE subject_id = ${rid} AND tenant_id = ${tenantId} AND status = 'pending'
    `;
    assert.equal(ar?.context?.["bias_scan"], undefined, "off mode records no bias_scan");
  });

  it("Test 10: reviewJdWithAi honours the jd_bias_review switch + logs usage when enabled", async () => {
    const rid = await createDraftWithJd("Own the payments platform and its reliability.");

    // Disabled → clean refusal, no model call, no usage row.
    await setAiSettings({ jd_bias_review: { enabled: false } });
    const before = await countReviewUsage();
    const disabled = await trpcMutation("reviewJdWithAi", { requisitionId: rid }, hiringManagerJwt);
    assert.ok(
      isErr(disabled) && disabled.error.data.code === "BAD_REQUEST",
      "disabled → BAD_REQUEST",
    );
    assert.match(disabled.error.message ?? "", /disabled/i);
    assert.equal(await countReviewUsage(), before, "no usage row written on refusal");

    // Enabled (default) → harvest a fixture, call, assert observations + a usage row.
    await clearBiasSettings(); // jd_bias_review defaults to enabled
    const miss = await trpcMutation("reviewJdWithAi", { requisitionId: rid }, hiringManagerJwt);
    assert.ok(isErr(miss), "first call misses the fixture");
    const match = /prompt hash ([a-f0-9]{64})/.exec(miss.error.message ?? "");
    assert.ok(match, `expected a prompt hash, got: ${miss.error.message}`);
    const hash = match[1]!;
    const fixturePath = resolve(FIXTURE_DIR, `${hash}.json`);
    writtenFixturePaths.push(fixturePath);
    await writeFile(
      fixturePath,
      JSON.stringify({
        json: {
          observations: [
            {
              excerpt: "own the payments platform",
              issue: "Consider naming the concrete outcomes expected.",
              suggestion: "Describe the systems and reliability targets the role owns.",
            },
          ],
        },
        inputTokens: 500,
        outputTokens: 200,
        costMicros: 5000,
        latencyMs: 400,
      }),
    );

    const usageBefore = await countReviewUsage();
    const ok = await trpcMutation<{ observations: unknown[]; model: string }>(
      "reviewJdWithAi",
      { requisitionId: rid },
      hiringManagerJwt,
    );
    assert.ok(!isErr(ok), `expected success, got ${JSON.stringify(ok)}`);
    assert.equal(ok.result.data.observations.length, 1, "observations returned");
    assert.equal(await countReviewUsage(), usageBefore + 1, "one jd_bias_review usage row written");
  });
});

async function countReviewUsage(): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.ai_usage_logs
    WHERE tenant_id = ${tenantId} AND feature = 'jd_bias_review'
  `;
  return Number(row?.n ?? 0);
}
