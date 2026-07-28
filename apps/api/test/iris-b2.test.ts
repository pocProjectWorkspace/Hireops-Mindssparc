/**
 * IRIS-B2 — FILTER-based BULK pipeline actions through the transactional
 * assistant (honesty test). Over real cloud-minted JWTs (the seeded personas):
 *
 *   Test 1 (PREVIEW + FILTER precision): irisPreview(bulk_advance_applications)
 *     resolves the (requisition + current stage) filter server-side to the EXACT
 *     set of matching applications — returning the affectedCount + the affected
 *     list BEFORE any confirm. An application on the SAME requisition at a
 *     DIFFERENT stage is NOT in the resolved set (the batch never touches it). An
 *     empty filter honestly resolves to zero.
 *
 *   Test 2 (HONESTY, happy path): irisExecute(bulk_advance_applications) LOOPS
 *     the SAME gated advanceApplication procedure over each matching application
 *     — real application_state_transitions rows are written, every matching
 *     application's current_stage changes, the off-filter application is
 *     untouched, and ONE assistant_actions provenance row is recorded PER
 *     succeeded application (a pill per candidate), read back by irisGetProvenance.
 *     No bulk side write-path.
 *
 *   Test 3 (PER-ACTION gate — IRIS-B1.1 mirrored for bulk): the bulk actions are
 *     gated per-action to admin + recruiter. A recruiter previews + executes them
 *     and sees them in the menu; a hiring_manager is FORBIDDEN and they are absent
 *     from the hiring_manager menu.
 *
 *   Test 4 (PARTIAL FAILURE tolerated + reported): a bulk advance out of hr_round
 *     to the offer stage is gated per-row by the HROPS-01 HR-round assessment. One
 *     application HAS a 'proceed' assessment (advances), the other has NONE (its
 *     per-row advance throws) — the batch does NOT abort: total=2, succeeded=1,
 *     failed=1, and only the succeeded application moved + got a provenance row.
 *
 * The recruiter_review → ai_screening advance is a BACKWARD move (skips the
 * forward-only field-policy gates); ai_screening is not candidate-visible so no
 * email is enqueued. Requires `pnpm db:seed:test-users`. Seeds its own FK chain
 * and cleans it up (child-first) in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// Unique per run so a shared-DB rerun never collides.
const RUN = Date.now().toString(36);
const BU = randomUUID();
const POSITION = randomUUID();
const JD = randomUUID();
const REQ = randomUUID();

// Five applications on the ONE requisition:
//   APP1, APP2  → recruiter_review (the bulk-advance target set)
//   APP3        → shortlisted      (off-filter — must never be touched)
//   APP4, APP5  → hr_round         (the partial-failure set; APP4 has an assessment)
interface SeedApp {
  app: string;
  candidate: string;
  person: string;
  stage: string;
}
const SEED: SeedApp[] = [
  { app: randomUUID(), candidate: randomUUID(), person: randomUUID(), stage: "recruiter_review" },
  { app: randomUUID(), candidate: randomUUID(), person: randomUUID(), stage: "recruiter_review" },
  { app: randomUUID(), candidate: randomUUID(), person: randomUUID(), stage: "shortlisted" },
  { app: randomUUID(), candidate: randomUUID(), person: randomUUID(), stage: "hr_round" },
  { app: randomUUID(), candidate: randomUUID(), person: randomUUID(), stage: "hr_round" },
];
const [S1, S2, S3, S4, S5] = SEED as [SeedApp, SeedApp, SeedApp, SeedApp, SeedApp];
const APP1 = S1.app;
const APP2 = S2.app;
const APP3 = S3.app;
const APP4 = S4.app;
const APP5 = S5.app;
const APPS = SEED.map((s) => s.app);
const CANDIDATES = SEED.map((s) => s.candidate);
const PERSONS = SEED.map((s) => s.person);
const ASSESSMENT = randomUUID();

let adminJwt: string;
let recruiterJwt: string;
let hiringManagerJwt: string;
let tenantId: string;

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

async function cleanupChain(): Promise<void> {
  await poolSql`DELETE FROM public.assistant_actions WHERE tenant_id = ${tenantId} AND entity_id = ANY(${APPS})`;
  await poolSql`DELETE FROM public.notification_outbox WHERE recipient_candidate_id = ANY(${CANDIDATES})`;
  await poolSql`DELETE FROM public.hr_round_assessments WHERE application_id = ANY(${APPS})`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${APPS})`;
  await poolSql`DELETE FROM public.applications WHERE id = ANY(${APPS})`;
  await poolSql`DELETE FROM public.candidates WHERE id = ANY(${CANDIDATES})`;
  await poolSql`DELETE FROM public.persons WHERE id = ANY(${PERSONS})`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU}`;
}

interface IrisPreviewOutput {
  summary: string;
  details: string[];
  affected?: { entityId: string; label: string }[];
  affectedCount?: number;
}
interface IrisExecuteOutput {
  ok: true;
  entityType: string;
  entityId: string | null;
  resultSummary: string;
  entityIds?: string[];
  total?: number;
  succeeded?: number;
  failed?: number;
}
interface IrisProvenanceOutput {
  rows: {
    entityId: string;
    assistant: string;
    actionId: string;
    confirmedByUserId: string | null;
    createdAt: string;
  }[];
}

describe("IRIS-B2 bulk pipeline actions through Iris (honesty)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hiringManagerJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // A membership to hang the requisition + assessment off (any active member works).
    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE au.email = ${ADMIN} AND tum.tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (!m) throw new Error(`admin membership for ${ADMIN} not found`);
    const membershipId = m.id;

    await cleanupChain();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, ${`IRIS-B2 BU ${RUN}`}, ${`iris-b2-bu-${RUN}`})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, ${`IRIS-B2 Engineer ${RUN}`}, 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${membershipId}, ${membershipId}, 'posted')
    `;
    let n = 0;
    for (const s of SEED) {
      n += 1;
      await poolSql`
        INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
        VALUES (${s.person}, ${tenantId}, ${`IRIS-B2 Candidate ${n} ${RUN}`}, ${`iris-b2-${n}-${RUN}@example.com`}, ${`iris-b2-${n}-${RUN}@example.com`})
      `;
      await poolSql`
        INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
        VALUES (${s.candidate}, ${tenantId}, ${s.person}, 'career_site', 'v1')
      `;
      await poolSql`
        INSERT INTO public.applications
          (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
        VALUES (${s.app}, ${tenantId}, ${s.candidate}, ${REQ}, 'career_site', ${s.stage}, now())
      `;
    }
    // APP4 gets a 'proceed' HR-round assessment so it PASSES the forward gate out
    // of hr_round; APP5 has none so its per-row advance throws (partial failure).
    await poolSql`
      INSERT INTO public.hr_round_assessments
        (id, tenant_id, application_id, rating, recommendation, completed_by_membership_id)
      VALUES (${ASSESSMENT}, ${tenantId}, ${APP4}, 4, 'proceed', ${membershipId})
    `;
  });

  afterAll(async () => {
    try {
      await cleanupChain();
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1 (PREVIEW + FILTER precision): irisPreview resolves the exact affected set, excludes off-filter apps, and honestly returns zero for an empty filter", async () => {
    const preview = await trpcQuery<IrisPreviewOutput>(
      "irisPreview",
      {
        actionId: "bulk_advance_applications",
        params: {
          requisitionId: REQ,
          fromStage: "recruiter_review",
          targetStage: "ai_screening",
        },
      },
      recruiterJwt,
    );
    assert.ok(!isErr(preview), `recruiter preview allowed, got ${JSON.stringify(preview)}`);
    assert.ok(preview.result.data.summary.length > 0, "preview has a filter summary");
    assert.equal(preview.result.data.affectedCount, 2, "exactly the two recruiter_review apps");
    const ids = new Set((preview.result.data.affected ?? []).map((a) => a.entityId));
    assert.ok(ids.has(APP1) && ids.has(APP2), "affected set is APP1 + APP2");
    assert.ok(!ids.has(APP3), "the off-filter (shortlisted) app is NOT in the resolved set");
    assert.ok(
      !ids.has(APP4) && !ids.has(APP5),
      "hr_round apps are not in a recruiter_review filter",
    );
    // Every affected row carries a human label for the confirm-N list.
    for (const a of preview.result.data.affected ?? []) {
      assert.ok(a.label.length > 0, "affected row has a human label");
    }

    // An empty filter resolves honestly to zero (the client shows "no matches").
    const empty = await trpcQuery<IrisPreviewOutput>(
      "irisPreview",
      {
        actionId: "bulk_advance_applications",
        params: { requisitionId: REQ, fromStage: "withdrawn", targetStage: "ai_screening" },
      },
      recruiterJwt,
    );
    assert.ok(!isErr(empty), `empty-filter preview ok, got ${JSON.stringify(empty)}`);
    assert.equal(empty.result.data.affectedCount, 0, "no candidates match the empty filter");
    assert.equal((empty.result.data.affected ?? []).length, 0, "affected list is empty");
  });

  it("Test 2 (HONESTY): irisExecute(bulk_advance) loops the real gated procedure over the matching apps, moves them, leaves the off-filter app untouched, and records one provenance row per app", async () => {
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      {
        actionId: "bulk_advance_applications",
        params: {
          requisitionId: REQ,
          fromStage: "recruiter_review",
          targetStage: "ai_screening",
        },
      },
      // As RECRUITER — proves the per-action gate opens for the WRITE path, not
      // just preview (mirrors the B1 recruiter execute).
      recruiterJwt,
    );
    assert.ok(!isErr(exec), `recruiter bulk advance ok, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.ok, true);
    assert.equal(exec.result.data.entityType, "application");
    assert.equal(exec.result.data.total, 2, "batch size 2");
    assert.equal(exec.result.data.succeeded, 2, "both matching apps advanced");
    assert.equal(exec.result.data.failed, 0, "no failures on the backward move");
    const returnedIds = new Set(exec.result.data.entityIds ?? []);
    assert.ok(returnedIds.has(APP1) && returnedIds.has(APP2), "both ids reported as succeeded");

    // The REAL applications moved — the gated procedure ran per row, not a side path.
    const moved = await poolSql<{ id: string; current_stage: string }[]>`
      SELECT id, current_stage FROM public.applications WHERE id = ANY(${[APP1, APP2]})
    `;
    for (const row of moved) {
      assert.equal(row.current_stage, "ai_screening", `${row.id} really advanced`);
    }
    // The off-filter application was NEVER touched.
    const [off] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP3}
    `;
    assert.equal(off?.current_stage, "shortlisted", "the off-filter app stayed put");

    // Real transition rows were written for each moved app.
    for (const appId of [APP1, APP2]) {
      const [tx] = await poolSql<{ from_stage: string; to_stage: string }[]>`
        SELECT from_stage, to_stage FROM public.application_state_transitions
        WHERE application_id = ${appId} ORDER BY transitioned_at DESC LIMIT 1
      `;
      assert.ok(tx, `a transition row exists for ${appId}`);
      assert.equal(tx.from_stage, "recruiter_review");
      assert.equal(tx.to_stage, "ai_screening");
    }

    // ONE provenance row per succeeded app (a pill per candidate), read back.
    const provRows = await poolSql<{ entity_id: string; assistant: string; action_id: string }[]>`
      SELECT entity_id, assistant, action_id FROM public.assistant_actions
      WHERE tenant_id = ${tenantId} AND entity_id = ANY(${[APP1, APP2]})
    `;
    assert.equal(provRows.length, 2, "two provenance rows — one per succeeded app");
    for (const p of provRows) {
      assert.equal(p.assistant, "iris");
      assert.equal(p.action_id, "bulk_advance_applications");
    }
    const prov = await trpcQuery<IrisProvenanceOutput>(
      "irisGetProvenance",
      { entityType: "application", entityIds: [APP1, APP2] },
      recruiterJwt,
    );
    assert.ok(!isErr(prov), `getProvenance ok, got ${JSON.stringify(prov)}`);
    const readIds = new Set(prov.result.data.rows.map((r) => r.entityId));
    assert.ok(readIds.has(APP1) && readIds.has(APP2), "provenance read back for both apps");
    for (const r of prov.result.data.rows) {
      assert.equal(r.assistant, "iris");
      assert.equal(r.actionId, "bulk_advance_applications");
    }
  });

  it("Test 3 (PER-ACTION gate): recruiter can preview + sees the bulk actions; hiring_manager is FORBIDDEN and they are absent from the hiring_manager menu", async () => {
    // recruiter menu carries both bulk actions.
    const recruiterList = await trpcQuery<{ actions: { id: string; bulk: boolean }[] }>(
      "irisListActions",
      {},
      recruiterJwt,
    );
    assert.ok(!isErr(recruiterList), `recruiter list ok, got ${JSON.stringify(recruiterList)}`);
    const recruiterIds = new Set(recruiterList.result.data.actions.map((a) => a.id));
    assert.ok(recruiterIds.has("bulk_advance_applications"), "recruiter menu has bulk advance");
    assert.ok(recruiterIds.has("bulk_reject_applications"), "recruiter menu has bulk reject");
    for (const a of recruiterList.result.data.actions) {
      if (a.id.startsWith("bulk_")) assert.equal(a.bulk, true, `${a.id} flagged bulk`);
    }

    // hiring_manager is NOT in the bulk action role set.
    const hmList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      hiringManagerJwt,
    );
    assert.ok(!isErr(hmList), `hm list ok, got ${JSON.stringify(hmList)}`);
    const hmIds = new Set(hmList.result.data.actions.map((a) => a.id));
    assert.ok(!hmIds.has("bulk_advance_applications"), "hm menu OMITS bulk advance");
    assert.ok(!hmIds.has("bulk_reject_applications"), "hm menu OMITS bulk reject");

    // hiring_manager preview of a bulk action is FORBIDDEN on that action.
    const hmPreview = await trpcQuery(
      "irisPreview",
      {
        actionId: "bulk_reject_applications",
        params: { requisitionId: REQ, fromStage: "recruiter_review" },
      },
      hiringManagerJwt,
    );
    assert.ok(
      isErr(hmPreview) && hmPreview.error.data.code === "FORBIDDEN",
      `hm bulk reject preview forbidden, got ${JSON.stringify(hmPreview)}`,
    );

    // hiring_manager execute is FORBIDDEN before commit too.
    const hmExec = await trpcMutation(
      "irisExecute",
      {
        actionId: "bulk_reject_applications",
        params: { requisitionId: REQ, fromStage: "recruiter_review" },
      },
      hiringManagerJwt,
    );
    assert.ok(
      isErr(hmExec) && hmExec.error.data.code === "FORBIDDEN",
      `hm bulk reject execute forbidden, got ${JSON.stringify(hmExec)}`,
    );
  });

  it("Test 4 (PARTIAL FAILURE): one per-row advance fails the HR-round gate; the batch tolerates it — total=2, succeeded=1, failed=1, only the passing app moved + got a provenance row", async () => {
    const exec = await trpcMutation<IrisExecuteOutput>(
      "irisExecute",
      {
        actionId: "bulk_advance_applications",
        params: {
          requisitionId: REQ,
          fromStage: "hr_round",
          // offer_accepted is gated ONLY by the HROPS-01 HR-round assessment
          // (no candidate-field policy gates it) — a deterministic per-row gate.
          targetStage: "offer_accepted",
        },
      },
      adminJwt,
    );
    assert.ok(!isErr(exec), `bulk advance (partial) ok, got ${JSON.stringify(exec)}`);
    assert.equal(exec.result.data.total, 2, "both hr_round apps were in the batch");
    assert.equal(
      exec.result.data.succeeded,
      1,
      "only the app with a 'proceed' assessment advanced",
    );
    assert.equal(
      exec.result.data.failed,
      1,
      "the app without an assessment failed its per-row gate",
    );
    assert.deepEqual(exec.result.data.entityIds, [APP4], "only APP4 reported as succeeded");

    // APP4 really moved; APP5 stayed at hr_round (its per-row advance threw).
    const [a4] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP4}
    `;
    const [a5] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP5}
    `;
    assert.equal(a4?.current_stage, "offer_accepted", "APP4 advanced past the gate");
    assert.equal(a5?.current_stage, "hr_round", "APP5 was blocked but the batch continued");

    // Exactly one provenance row — for the succeeded app only.
    const prov = await poolSql<{ entity_id: string }[]>`
      SELECT entity_id FROM public.assistant_actions
      WHERE tenant_id = ${tenantId}
        AND action_id = 'bulk_advance_applications'
        AND entity_id = ANY(${[APP4, APP5]})
    `;
    assert.equal(prov.length, 1, "one provenance row (only the succeeded app)");
    assert.equal(prov[0]?.entity_id, APP4, "provenance is for APP4");
  });
});
