/**
 * HRHEAD-02 — Market Intelligence (honest benchmarks) + Feasibility (real AI).
 *
 * Exercises the four HRHEAD-02 procedures over real cloud-minted JWTs
 * (reality #110 — sign in as the seeded personas):
 *
 *   Test 1: upsertMarketBenchmark (admin) writes a row; listMarketBenchmarks
 *           (hr_head) reads it back. Regenerate-safe: a second upsert on the
 *           same (tenant, role_title) updates in place (still one row).
 *   Test 2: role gating — recruiter FORBIDDEN on listMarketBenchmarks (not a
 *           read role); hr_head FORBIDDEN on upsertMarketBenchmark (admin-only).
 *   Test 3: generateRequisitionFeasibility (local AI) against a req whose title
 *           MATCHES a benchmark → row upserted + a req_feasibility ai_usage_logs
 *           row (succeeded) + usedBenchmark=true. Regenerate REPLACES (still one
 *           row, refreshed).
 *   Test 4: no-benchmark fallback — a req whose title matches no benchmark →
 *           honest benchmark-free mode, usedBenchmark=false, still a real
 *           assessment row.
 *   Test 5: recruiter FORBIDDEN on generateRequisitionFeasibility.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures), so no real tokens are spent.
 * Requires `pnpm db:seed:test-users` (admin1 / hrhead1 / hiringmanager1 /
 * recruiter1). Cleans up its own rows in afterAll.
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const BENCH_ROLE = `HRHEAD-02 Bench Role ${RUN}`;
const REQ_MATCH_TITLE = `HRHEAD-02 Bench Role ${RUN}`; // exact-matches BENCH_ROLE
const REQ_NOBENCH_TITLE = `Zzz Novelty Specialist ${RUN}`; // matches no benchmark
const DEPT = `HRHEAD-02 QA ${RUN}`;

let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;
let adminJwt: string;
let tenantId: string;
let reqMatchId = "";
let reqNoBenchId = "";
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

/** Create a draft requisition + a couple of skills, return its id. */
async function createReqWithSkills(title: string): Promise<string> {
  const draft = await trpcMutation<{ requisitionId: string }>(
    "createRequisitionDraft",
    {
      title,
      department: DEPT,
      locationType: "hybrid",
      primaryLocation: "Bengaluru",
      seniority: "Senior",
    },
    hiringManagerJwt,
  );
  assert.ok(!isErr(draft), `createRequisitionDraft: ${JSON.stringify(draft)}`);
  const id = draft.result.data.requisitionId;
  const upd = await trpcMutation(
    "updateRequisitionDraft",
    {
      requisitionId: id,
      skills: [
        { skillName: "Go", weight: 1, isRequired: true },
        { skillName: "Kubernetes", weight: 0.8, isRequired: false },
      ],
    },
    hiringManagerJwt,
  );
  assert.ok(!isErr(upd), `updateRequisitionDraft: ${JSON.stringify(upd)}`);
  return id;
}

/**
 * Fire a generate call; on the first (fixture-miss) run, harvest the prompt
 * hash from the error, write a matching feasibility fixture, and retry.
 */
async function generateWithFixture(reqId: string, jwt: string) {
  const first = await trpcMutation<{ usedBenchmark: boolean }>(
    "generateRequisitionFeasibility",
    { requisitionId: reqId },
    jwt,
  );
  if (!isErr(first)) return first; // fixture already present from a prior run
  const match = /prompt hash ([a-f0-9]{64})/.exec(first.error.message ?? "");
  assert.ok(match, `expected a prompt hash in the error, got: ${first.error.message}`);
  const hash = match[1]!;
  const path = resolve(FIXTURE_DIR, `${hash}.json`);
  writtenFixtures.push(path);
  await writeFile(
    path,
    JSON.stringify({
      json: {
        skillsFit: 72,
        expCompFit: 65,
        difficulty: "medium",
        recommendedSalaryAdjustmentPct: 8,
        recommendation:
          "This role is fillable within a normal cycle. Skills are attainable in the market; the budget is close to the median but a modest lift would speed the fill.",
        supplyNote: "Moderate supply — expect a 6-8 week search for senior candidates.",
      },
      inputTokens: 700,
      outputTokens: 260,
      costMicros: 9500,
      latencyMs: 700,
    }),
  );
  const second = await trpcMutation<{ usedBenchmark: boolean }>(
    "generateRequisitionFeasibility",
    { requisitionId: reqId },
    jwt,
  );
  return second;
}

describe("HRHEAD-02 market intelligence + feasibility", () => {
  beforeAll(async () => {
    [recruiterJwt, hiringManagerJwt, hrHeadJwt, adminJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
      signIn(ADMIN),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
  });

  afterAll(async () => {
    try {
      for (const id of [reqMatchId, reqNoBenchId].filter(Boolean)) {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${id}
        `;
        // requisition_feasibility cascades on requisition delete.
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${id}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${id}`;
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      }
      await poolSql`DELETE FROM public.market_benchmarks WHERE tenant_id = ${tenantId} AND role_title = ${BENCH_ROLE}`;
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name = ${DEPT.trim()}`;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail the suite.
    }
    for (const p of writtenFixtures) await unlink(p).catch(() => {});
  });

  it("Test 1: upsertMarketBenchmark (admin) + listMarketBenchmarks (hr_head) round-trip + idempotent update", async () => {
    const up = await trpcMutation<{ row: { roleTitle: string; medianSalaryMinor: number } }>(
      "upsertMarketBenchmark",
      {
        roleTitle: BENCH_ROLE,
        medianSalaryMinor: 420_000_000,
        currency: "INR",
        ttfDays: 45,
        availability: "medium",
        competitorDemand: "high",
        recommendedRounds: 4,
        trendingSkills: ["Go", "Kubernetes"],
        sourceNote: "Curated benchmark — update quarterly",
      },
      adminJwt,
    );
    assert.ok(!isErr(up), `upsert: ${JSON.stringify(up)}`);
    assert.equal(up.result.data.row.medianSalaryMinor, 420_000_000);

    const list = await trpcQuery<{ rows: { roleTitle: string; medianSalaryMinor: number }[] }>(
      "listMarketBenchmarks",
      {},
      hrHeadJwt,
    );
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const mine = list.result.data.rows.find((r) => r.roleTitle === BENCH_ROLE);
    assert.ok(mine, "seeded benchmark appears for hr_head");
    assert.equal(mine!.medianSalaryMinor, 420_000_000);

    // Idempotent update — change the median, expect still exactly one row.
    const up2 = await trpcMutation(
      "upsertMarketBenchmark",
      {
        roleTitle: BENCH_ROLE,
        medianSalaryMinor: 450_000_000,
        currency: "INR",
        ttfDays: 50,
        availability: "low",
        competitorDemand: "high",
        recommendedRounds: 4,
        trendingSkills: ["Go", "Kubernetes", "Distributed Systems"],
        sourceNote: "Curated benchmark — update quarterly",
      },
      adminJwt,
    );
    assert.ok(!isErr(up2), `upsert2: ${JSON.stringify(up2)}`);
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.market_benchmarks
      WHERE tenant_id = ${tenantId} AND role_title = ${BENCH_ROLE}
    `;
    assert.equal(Number(n), 1, "still exactly one benchmark row (upsert replaced)");
    const [{ median } = { median: "0" }] = await poolSql<{ median: string }[]>`
      SELECT median_salary_minor::text AS median FROM public.market_benchmarks
      WHERE tenant_id = ${tenantId} AND role_title = ${BENCH_ROLE}
    `;
    assert.equal(median, "450000000", "median updated in place");
  });

  it("Test 2: role gating — recruiter FORBIDDEN on read; hr_head FORBIDDEN on upsert", async () => {
    const read = await trpcQuery("listMarketBenchmarks", {}, recruiterJwt);
    assert.ok(
      isErr(read) && read.error.data.code === "FORBIDDEN",
      "recruiter cannot read benchmarks",
    );

    const write = await trpcMutation(
      "upsertMarketBenchmark",
      {
        roleTitle: BENCH_ROLE,
        medianSalaryMinor: 1,
        currency: "INR",
        ttfDays: 1,
        availability: "low",
        competitorDemand: "low",
        recommendedRounds: 1,
        trendingSkills: [],
        sourceNote: "x",
      },
      hrHeadJwt,
    );
    assert.ok(
      isErr(write) && write.error.data.code === "FORBIDDEN",
      "hr_head cannot upsert benchmarks",
    );
  });

  it("Test 3: generate feasibility with a matched benchmark → row + usage log + regenerate replaces", async () => {
    reqMatchId = await createReqWithSkills(REQ_MATCH_TITLE);
    const res = await generateWithFixture(reqMatchId, hrHeadJwt);
    assert.ok(!isErr(res), `generate: ${JSON.stringify(res)}`);
    assert.equal(res.result.data.usedBenchmark, true, "req title matched the seeded benchmark");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_feasibility
      WHERE tenant_id = ${tenantId} AND requisition_id = ${reqMatchId}
    `;
    assert.equal(Number(n), 1, "one feasibility row upserted");

    const [{ un } = { un: 0 }] = await poolSql<{ un: number }[]>`
      SELECT count(*)::int AS un FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'req_feasibility' AND succeeded = true
    `;
    assert.ok(Number(un) >= 1, "a successful req_feasibility ai_usage_logs row exists");

    // Regenerate → still exactly one row (replace, not append).
    const again = await generateWithFixture(reqMatchId, hrHeadJwt);
    assert.ok(!isErr(again), `regenerate: ${JSON.stringify(again)}`);
    const [{ n2 } = { n2: 0 }] = await poolSql<{ n2: number }[]>`
      SELECT count(*)::int AS n2 FROM public.requisition_feasibility
      WHERE tenant_id = ${tenantId} AND requisition_id = ${reqMatchId}
    `;
    assert.equal(Number(n2), 1, "regenerate replaced the row (still one)");

    // The cached assessment is readable via getRequisitionFeasibility.
    const got = await trpcQuery<{ card: { assessment: { skillsFit: number } | null } | null }>(
      "getRequisitionFeasibility",
      { requisitionId: reqMatchId },
      adminJwt,
    );
    assert.ok(!isErr(got), `get: ${JSON.stringify(got)}`);
    assert.ok(got.result.data.card?.assessment, "assessment present on the card");
  });

  it("Test 4: no-benchmark fallback → honest benchmark-free assessment", async () => {
    reqNoBenchId = await createReqWithSkills(REQ_NOBENCH_TITLE);
    const res = await generateWithFixture(reqNoBenchId, hrHeadJwt);
    assert.ok(!isErr(res), `generate: ${JSON.stringify(res)}`);
    assert.equal(
      res.result.data.usedBenchmark,
      false,
      "no benchmark matched — honest fallback ran",
    );

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_feasibility
      WHERE tenant_id = ${tenantId} AND requisition_id = ${reqNoBenchId}
    `;
    assert.equal(Number(n), 1, "a feasibility row exists even without a benchmark");
  });

  it("Test 5: recruiter FORBIDDEN on generateRequisitionFeasibility", async () => {
    const res = await trpcMutation(
      "generateRequisitionFeasibility",
      { requisitionId: reqMatchId },
      recruiterJwt,
    );
    assert.ok(
      isErr(res) && res.error.data.code === "FORBIDDEN",
      "recruiter cannot generate feasibility",
    );
  });
});
