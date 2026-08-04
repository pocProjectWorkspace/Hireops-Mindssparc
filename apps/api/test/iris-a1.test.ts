/**
 * IRIS-A1 — transactional-assistant backend spine, menu path (honesty test).
 *
 * The ONE end-to-end guarantee this ticket must earn, over real cloud-minted
 * JWTs (reality #110 — the seeded personas):
 *
 *   Test 1 (HONESTY, happy path): as admin1, irisExecute(create_requisition_jd)
 *     creates a REAL requisition (status draft) via the SAME gated procedures a
 *     human uses (createRequisitionDraft → generateJdDraft), AND an
 *     assistant_actions provenance row exists for it, AND irisGetProvenance
 *     reads it back with assistant='iris' + the confirming user's id.
 *   Test 2 (FLIP): a requisition created by the HUMAN path (createRequisitionDraft
 *     directly) has NO provenance row — irisGetProvenance returns nothing for it.
 *   Test 3: an UNKNOWN actionId is rejected (whitelist-only dispatch).
 *   Test 4 (HONESTY, the gate fires THROUGH Iris): as recruiter1 (not a
 *     requisition-write role), irisExecute is FORBIDDEN — proof Iris runs the
 *     real gated procedure, never a side write-path. irisListActions is
 *     likewise gated.
 *
 * NODE_ENV=test forces the LocalAIClient, so generateJdDraft needs a fixture for
 * the exact prompt. The prompt is deterministic given (title, locationType,
 * primaryLocation, seniority, company) — no req id / timestamp — so we harvest
 * the prompt-hash from a first (JD-failing) execute, write the fixture, delete
 * the harvest requisition to free the title, then execute for real. Same
 * fixture-harvest technique as req-02 / ai-03.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1). Cleans up its own
 * rows + the harvested fixture in afterAll.
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@mindssparc.com";
const RECRUITER = "recruiter1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE = `IRIS-A1 Platform Engineer ${RUN}`;
const DEPARTMENT = `IRIS-A1 Platform ${RUN}`;
const HUMAN_TITLE = `IRIS-A1 Human Analyst ${RUN}`;
const HUMAN_DEPARTMENT = `IRIS-A1 Human ${RUN}`;

const EXEC_INPUT = {
  title: TITLE,
  department: DEPARTMENT,
  locationType: "hybrid",
  primaryLocation: "Bengaluru",
  seniority: "Senior",
};

let adminJwt: string;
let recruiterJwt: string;
let adminUserId: string;
let tenantId: string;
let writtenFixturePath: string | null = null;
let irisReqId: string | null = null;
let humanReqId: string | null = null;

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

/** Delete a requisition + its position/jd/transitions (child-first). */
async function dropRequisition(reqId: string): Promise<void> {
  const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
    SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${reqId}
  `;
  await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${reqId}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${reqId}`;
  if (row?.jd_version_id) {
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
  }
  if (row?.position_id) {
    await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
  }
}

async function requisitionIdByTitle(title: string): Promise<string | null> {
  const [row] = await poolSql<{ id: string }[]>`
    SELECT r.id
    FROM public.requisitions r
    JOIN public.positions p ON p.id = r.position_id
    WHERE p.tenant_id = ${tenantId} AND p.title = ${title}
    LIMIT 1
  `;
  return row?.id ?? null;
}

interface IrisExecuteOutput {
  ok: true;
  entityType: string;
  entityId: string | null;
  resultSummary: string;
}
interface IrisProvenanceOutput {
  rows: {
    entityId: string;
    assistant: string;
    actionId: string;
    confirmedByUserId: string | null;
    confirmedByLabel?: string | null;
    createdAt: string;
  }[];
}

describe("IRIS-A1 transactional assistant — menu path (honesty)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    adminUserId = decodeJwt(adminJwt).sub as string;
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // Pre-clean any residue from a previous run of this test (shared dev DB).
    for (const title of [TITLE, HUMAN_TITLE]) {
      const id = await requisitionIdByTitle(title);
      if (id) {
        await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ${id}`;
        await dropRequisition(id);
      }
    }
  });

  afterAll(async () => {
    try {
      for (const id of [irisReqId, humanReqId]) {
        if (!id) continue;
        await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ${id}`;
        await dropRequisition(id);
      }
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name IN (${DEPARTMENT.trim()}, ${HUMAN_DEPARTMENT.trim()})`;
    } catch {
      // Best-effort — leave residue for the groom sweep rather than fail.
    }
    if (writtenFixturePath) {
      await unlink(writtenFixturePath).catch(() => {});
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1 (HONESTY): irisExecute creates a real requisition + persists provenance read back by irisGetProvenance", async () => {
    // Phase 1 — harvest the JD prompt hash. createRequisitionDraft commits its
    // own tx first (req exists), then generateJdDraft misses the fixture and
    // throws with the hash. irisExecute surfaces that error (no provenance row).
    const harvest = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      { actionId: "create_requisition_jd", params: EXEC_INPUT },
      adminJwt,
    );
    assert.ok(isErr(harvest), "first execute should miss the JD fixture");
    const match = /prompt hash ([a-f0-9]{64})/.exec(harvest.error.message ?? "");
    assert.ok(match, `expected a prompt hash in the error, got: ${harvest.error.message}`);
    const hash = match[1]!;
    writtenFixturePath = resolve(FIXTURE_DIR, `${hash}.json`);
    await writeFile(
      writtenFixturePath,
      JSON.stringify({
        json: {
          summary: `A senior platform engineer owning reliability for the ${DEPARTMENT} team.`,
          responsibilities: [
            "Own platform reliability and delivery.",
            "Partner with product teams on scaling.",
            "Drive observability and incident response.",
          ],
          requirements: [
            "5+ years in platform / infrastructure engineering.",
            "Strong distributed-systems fundamentals.",
            "Experience with cloud + CI/CD.",
          ],
        },
        inputTokens: 600,
        outputTokens: 320,
        costMicros: 9000,
        latencyMs: 800,
      }),
    );

    // The harvest requisition committed (JD failed) — drop it so the retry's
    // title is unique AND the prompt (hence hash) is identical.
    const harvestReqId = await requisitionIdByTitle(TITLE);
    assert.ok(
      harvestReqId,
      "harvest requisition was really created (createRequisitionDraft committed)",
    );
    await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ${harvestReqId}`;
    await dropRequisition(harvestReqId!);

    // Phase 2 — the real execute now that the fixture exists.
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      { actionId: "create_requisition_jd", params: EXEC_INPUT },
      adminJwt,
    );
    assert.ok(!isErr(exec), `execute should succeed, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.ok, true);
    assert.equal(exec.result.data.entityType, "requisition");
    irisReqId = exec.result.data.entityId;
    assert.ok(irisReqId, "entityId (requisition id) returned");
    assert.ok(exec.result.data.resultSummary.length > 0, "resultSummary is non-empty");

    // A REAL requisition (status draft) exists — created via the gated procedure.
    const [req] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.requisitions WHERE id = ${irisReqId}
    `;
    assert.ok(req, "requisition row exists in the DB");
    assert.equal(req.status, "draft", "requisition is a real draft");

    // A provenance row was PERSISTED for it, stamped iris + the confirming user.
    const [prov] = await poolSql<
      {
        assistant: string;
        action_id: string;
        entity_type: string;
        confirmed_by_user_id: string;
        status: string;
      }[]
    >`
      SELECT assistant, action_id, entity_type, confirmed_by_user_id, status
      FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ${irisReqId}
    `;
    assert.ok(prov, "assistant_actions provenance row exists");
    assert.equal(prov.assistant, "iris");
    assert.equal(prov.action_id, "create_requisition_jd");
    assert.equal(prov.entity_type, "requisition");
    assert.equal(prov.status, "executed");
    assert.equal(prov.confirmed_by_user_id, adminUserId, "confirming user is the caller");

    // irisGetProvenance READS IT BACK (RLS-scoped), with assistant + confirmer.
    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "requisition", entityIds: [irisReqId] },
      adminJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    assert.equal(prv.result.data.rows.length, 1, "exactly one provenance row read back");
    const p = prv.result.data.rows[0]!;
    assert.equal(p.entityId, irisReqId);
    assert.equal(p.assistant, "iris");
    assert.equal(p.actionId, "create_requisition_jd");
    assert.equal(p.confirmedByUserId, adminUserId, "confirming user read back");
  });

  it("Test 2 (FLIP): a human-created requisition has NO provenance", async () => {
    // The SAME gated procedure, called directly (the human path) — no Iris.
    const created = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      { title: HUMAN_TITLE, department: HUMAN_DEPARTMENT, locationType: "remote" },
      adminJwt,
    );
    assert.ok(!isErr(created), `human create should succeed, got ${JSON.stringify(created)}`);
    humanReqId = created.result.data.requisitionId;

    const prv = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "requisition", entityIds: [humanReqId] },
      adminJwt,
    );
    assert.ok(!isErr(prv), `getProvenance should succeed, got ${JSON.stringify(prv)}`);
    assert.equal(
      prv.result.data.rows.length,
      0,
      "human-created requisition carries NO iris provenance",
    );
  });

  it("Test 3: an unknown actionId is rejected (whitelist-only)", async () => {
    const bad = await trpcMutation(
      "irisExecute",
      { actionId: "drop_all_requisitions", params: {} },
      adminJwt,
    );
    assert.ok(
      isErr(bad) && bad.error.data.code === "BAD_REQUEST",
      `unknown actionId rejected, got ${JSON.stringify(bad)}`,
    );
  });

  it("Test 4 (HONESTY): the real gate fires THROUGH Iris — recruiter is FORBIDDEN", async () => {
    // recruiter is NOT a requisition-write role. irisExecute runs the SAME gated
    // createRequisitionDraft, so its FORBIDDEN gate fires — no side write-path.
    const forbidden = await trpcMutation(
      "irisExecute",
      { actionId: "create_requisition_jd", params: EXEC_INPUT },
      recruiterJwt,
    );
    assert.ok(
      isErr(forbidden) && forbidden.error.data.code === "FORBIDDEN",
      `recruiter execute forbidden, got ${JSON.stringify(forbidden)}`,
    );
    // No stray requisition was written by the forbidden attempt.
    const stray = await requisitionIdByTitle(TITLE);
    assert.equal(stray, irisReqId, "forbidden attempt wrote no new requisition");

    // irisListActions is gated the same way (recruiter cannot list).
    const list = await trpcQuery("irisListActions", {}, recruiterJwt);
    assert.ok(
      isErr(list) && list.error.data.code === "FORBIDDEN",
      `recruiter cannot list iris actions, got ${JSON.stringify(list)}`,
    );

    // admin CAN list, and the menu contains the whitelisted action.
    const adminList = await trpcQuery<{
      actions: { id: string; label: string; group: string; destructive: boolean; bulk: boolean }[];
    }>("irisListActions", {}, adminJwt);
    assert.ok(!isErr(adminList), `admin can list, got ${JSON.stringify(adminList)}`);
    assert.ok(
      adminList.result.data.actions.some((a) => a.id === "create_requisition_jd"),
      "menu contains create_requisition_jd",
    );
  });
});
