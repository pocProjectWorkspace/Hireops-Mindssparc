/**
 * REQ-02 (Wave A) — requisition creation: draft → real-AI JD → skills /
 * knockouts → submit for approval.
 *
 * Exercises the five REQ-02 procedures end-to-end over real cloud-minted JWTs
 * (reality #110 — sign in as the seeded personas):
 *
 *   Test 1: createRequisitionDraft writes position + draft jd_version +
 *           requisition(draft) + a state-transition row — transactionally.
 *   Test 2: recruiter is FORBIDDEN from createRequisitionDraft (write gate).
 *   Test 3: generateJdDraft in local-AI mode updates the jd_version and writes
 *           an ai_usage_logs row (feature=jd_generation, succeeded).
 *   Test 4: updateRequisitionDraft replace-sets skills + knockouts; the
 *           knockout rows are readable by the apply-flow evaluator
 *           (@hireops/ai-scoring evaluateKnockouts).
 *   Test 5: submitRequisitionForApproval creates the chain + a pending
 *           approval_request + a draft→pending_approval transition, and the
 *           req surfaces in the HR-head queue with its title.
 *   Test 6: a second submit is a clean alreadySubmitted (partial unique
 *           honoured — still exactly one pending request).
 *   Test 7: recruiter is FORBIDDEN from the mutations.
 *
 * NODE_ENV=test forces LocalAIClient (fixtures), so no real tokens are spent.
 * Requires `pnpm db:seed:test-users` (hiringmanager1 / hrhead1 / recruiter1).
 * Cleans up its own rows in afterAll.
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
import { evaluateKnockouts, type KnockoutInput } from "@hireops/ai-scoring";

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
const TENANT_SLUG = "kyndryl-poc";

// A per-run suffix keeps the position title unique so the active-title unique
// index doesn't collide across repeat runs on the shared dev DB.
const RUN = Date.now().toString(36);
const TITLE = `REQ-02 Test Engineer ${RUN}`;
const DEPARTMENT = `REQ-02 QA ${RUN}`;

let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;
let tenantId: string;
let reqId: string;
let writtenFixturePath: string | null = null;

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

describe("REQ-02 requisition creation", () => {
  beforeAll(async () => {
    [recruiterJwt, hiringManagerJwt, hrHeadJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
  });

  afterAll(async () => {
    // Best-effort child-first cleanup of this run's rows.
    try {
      if (reqId) {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${reqId}
        `;
        await poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId} AND subject_id = ${reqId}`;
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${reqId}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${reqId}`; // cascades knockouts
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`; // cascades jd_skills
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      }
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name = ${DEPARTMENT.trim()}`;
      // Orphan chains created by this run (no approval_request references them
      // after the delete above). Safe: RESTRICT would throw if still referenced.
      await poolSql`
        DELETE FROM public.approval_chains c
        WHERE c.tenant_id = ${tenantId}
          AND NOT EXISTS (SELECT 1 FROM public.approval_requests r WHERE r.chain_id = c.id)
          AND c.created_at >= now() - interval '30 minutes'
      `;
    } catch {
      // Cleanup is best-effort — leave residue for the groom sweep if a FK
      // ordering surprises us rather than failing the suite.
    }
    if (writtenFixturePath) {
      await unlink(writtenFixturePath).catch(() => {});
    }
  });

  it("Test 1: createRequisitionDraft writes position + jd_version + requisition + transition", async () => {
    const res = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      {
        title: TITLE,
        department: DEPARTMENT,
        locationType: "hybrid",
        primaryLocation: "Bengaluru",
        seniority: "Senior",
        numberOfOpenings: 2,
      },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    reqId = res.result.data.requisitionId;
    assert.ok(reqId, "requisitionId returned");

    const [req] = await poolSql<
      { status: string; number_of_openings: number; position_id: string; jd_version_id: string }[]
    >`SELECT status, number_of_openings, position_id, jd_version_id
      FROM public.requisitions WHERE id = ${reqId}`;
    assert.ok(req, "requisition row exists");
    assert.equal(req.status, "draft");
    assert.equal(Number(req.number_of_openings), 2);

    const [pos] = await poolSql<{ title: string }[]>`
      SELECT title FROM public.positions WHERE id = ${req.position_id}
    `;
    assert.equal(pos?.title, TITLE, "position created with the title");

    const [jd] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.jd_versions WHERE id = ${req.jd_version_id}
    `;
    assert.equal(jd?.status, "draft", "draft jd_version created");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_state_transitions
      WHERE requisition_id = ${reqId} AND to_status = 'draft'
    `;
    assert.ok(Number(n) >= 1, "a draft state-transition row exists");
  });

  it("Test 2: recruiter is FORBIDDEN from createRequisitionDraft", async () => {
    const res = await trpcMutation(
      "createRequisitionDraft",
      { title: `Nope ${RUN}`, department: `Nope ${RUN}`, locationType: "onsite" },
      recruiterJwt,
    );
    assert.ok(isErr(res), `expected FORBIDDEN, got ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "FORBIDDEN");
  });

  it("Test 3: generateJdDraft (local AI) updates jd_version + writes ai_usage_logs", async () => {
    // First call has no fixture — the LocalAIClient throws with the prompt
    // hash in the message. Harvest it, write a matching fixture, retry. This
    // guarantees the fixture services the exact prompt the router builds
    // (same technique as the AI-03 scoring test).
    const first = await trpcMutation("generateJdDraft", { requisitionId: reqId }, hiringManagerJwt);
    assert.ok(isErr(first), "first generate should miss the fixture");
    const match = /prompt hash ([a-f0-9]{64})/.exec(first.error.message ?? "");
    assert.ok(match, `expected a prompt hash in the error, got: ${first.error.message}`);
    const hash = match[1]!;
    writtenFixturePath = resolve(FIXTURE_DIR, `${hash}.json`);
    await writeFile(
      writtenFixturePath,
      JSON.stringify({
        json: {
          summary: `A senior test engineer role owning quality for the ${DEPARTMENT} team.`,
          responsibilities: [
            "Design and maintain automated test suites.",
            "Partner with engineers on release readiness.",
            "Own quality metrics and reporting.",
          ],
          requirements: [
            "5+ years in software quality engineering.",
            "Strong programming fundamentals.",
            "Experience with CI/CD pipelines.",
          ],
        },
        inputTokens: 600,
        outputTokens: 320,
        costMicros: 9000,
        latencyMs: 800,
      }),
    );

    const second = await trpcMutation<{ sections: { summary: string } }>(
      "generateJdDraft",
      { requisitionId: reqId },
      hiringManagerJwt,
    );
    assert.ok(!isErr(second), `expected success, got ${JSON.stringify(second)}`);
    assert.ok(second.result.data.sections.summary.length > 0, "sections returned");

    const [jd] = await poolSql<{ summary: string; jd_text: string }[]>`
      SELECT jv.summary, jv.jd_text
      FROM public.jd_versions jv
      JOIN public.requisitions r ON r.jd_version_id = jv.id
      WHERE r.id = ${reqId}
    `;
    assert.ok(jd?.summary && jd.summary.length > 0, "jd_version.summary populated");
    assert.ok(jd.jd_text.includes("Responsibilities"), "jd_text composed from sections");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'jd_generation' AND succeeded = true
    `;
    assert.ok(Number(n) >= 1, "a successful jd_generation ai_usage_logs row exists");
  });

  it("Test 4: updateRequisitionDraft sets skills + knockouts consumable by the evaluator", async () => {
    const res = await trpcMutation<{ skillCount: number; knockoutCount: number }>(
      "updateRequisitionDraft",
      {
        requisitionId: reqId,
        skills: [
          { skillName: "Playwright", weight: 1, isRequired: true },
          { skillName: "TypeScript", weight: 0.8, isRequired: false },
        ],
        knockouts: [
          {
            questionText: "Minimum 5 years of experience",
            type: "numeric_min",
            source: "parsed_cv",
            fieldPath: "total_years_experience",
            min: 5,
          },
        ],
      },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.skillCount, 2);
    assert.equal(res.result.data.knockoutCount, 1);

    // Pull the knockout row and feed it to the real apply-flow evaluator to
    // prove the shape we persist is consumable downstream.
    const rows = await poolSql<
      { id: string; type: string; source: string; threshold_value: unknown }[]
    >`SELECT id, type::text AS type, source, threshold_value
      FROM public.requisition_knockouts WHERE requisition_id = ${reqId}`;
    assert.equal(rows.length, 1, "one knockout row persisted");
    const inputs: KnockoutInput[] = rows.map((r) => ({
      id: r.id,
      type: r.type as KnockoutInput["type"],
      source: r.source,
      thresholdValue: r.threshold_value,
    }));
    const pass = evaluateKnockouts({ total_years_experience: 7 }, inputs);
    assert.equal(pass.passed, true, "7 years passes the ≥5 knockout");
    const fail = evaluateKnockouts({ total_years_experience: 3 }, inputs);
    assert.equal(fail.passed, false, "3 years fails the ≥5 knockout");
  });

  it("Test 5: submitRequisitionForApproval creates chain + pending request + transition", async () => {
    const res = await trpcMutation<{ approvalRequestId: string; alreadySubmitted: boolean }>(
      "submitRequisitionForApproval",
      { requisitionId: reqId },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.alreadySubmitted, false);

    const [ar] = await poolSql<{ status: string; chain_id: string }[]>`
      SELECT status, chain_id FROM public.approval_requests
      WHERE tenant_id = ${tenantId} AND subject_type = 'requisition' AND subject_id = ${reqId}
    `;
    assert.equal(ar?.status, "pending", "pending approval_request created");
    const [chain] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.approval_chains WHERE id = ${ar!.chain_id}
    `;
    assert.ok(Number(chain?.n) === 1, "chain row exists");

    const [req] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${reqId}
    `;
    assert.equal(req?.status, "pending_approval", "requisition transitioned");
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.requisition_state_transitions
      WHERE requisition_id = ${reqId} AND from_status = 'draft' AND to_status = 'pending_approval'
    `;
    assert.ok(Number(n) >= 1, "a draft→pending_approval transition exists");

    // Surfaces in the HR-head queue with the title.
    const queue = await trpcQuery<{ rows: { subjectId: string; title: string | null }[] }>(
      "listRequisitionApprovals",
      { limit: 100 },
      hrHeadJwt,
    );
    assert.ok(!isErr(queue), `expected queue success, got ${JSON.stringify(queue)}`);
    const mine = queue.result.data.rows.find((r) => r.subjectId === reqId);
    assert.ok(mine, "submitted req appears in the HR-head queue");
    assert.equal(mine!.title, TITLE, "queue row carries the requisition title");
  });

  it("Test 6: a second submit is a clean alreadySubmitted (partial unique honoured)", async () => {
    const res = await trpcMutation<{ alreadySubmitted: boolean }>(
      "submitRequisitionForApproval",
      { requisitionId: reqId },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.alreadySubmitted, true, "second submit is idempotent");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.approval_requests
      WHERE tenant_id = ${tenantId} AND subject_type = 'requisition'
        AND subject_id = ${reqId} AND status = 'pending'
    `;
    assert.equal(Number(n), 1, "still exactly one pending request");
  });

  it("Test 7: recruiter is FORBIDDEN from the mutations", async () => {
    const upd = await trpcMutation(
      "updateRequisitionDraft",
      { requisitionId: reqId, skills: [] },
      recruiterJwt,
    );
    assert.ok(isErr(upd) && upd.error.data.code === "FORBIDDEN", "update forbidden for recruiter");
    const sub = await trpcMutation(
      "submitRequisitionForApproval",
      { requisitionId: reqId },
      recruiterJwt,
    );
    assert.ok(isErr(sub) && sub.error.data.code === "FORBIDDEN", "submit forbidden for recruiter");
  });
});
