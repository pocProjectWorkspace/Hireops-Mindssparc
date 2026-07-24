/**
 * T3.3 / G16 — panel-pool library (org structure, FINAL Phase-3 ticket).
 *
 * Exercises the five management procedures + the HONESTY wiring into
 * upsertInterviewPlan, over real cloud-minted JWTs (reality #110 — sign in as
 * the seeded personas):
 *
 *   Test 1: createPanelPool (name + focus) + listPanelPools rows carry members.
 *   Test 2: list excludes archived by default, includes with the flag; archive
 *           excludes from the default list.
 *   Test 3: renamePanelPool changes name + focus.
 *   Test 4: (tenant, name) duplicate rejected (BAD_REQUEST).
 *   Test 5: setPanelPoolMembers replace-set; a foreign/inactive membership is
 *           rejected (assertActiveMemberships → BAD_REQUEST).
 *   Test 6: write gating — hiring_manager CAN list, CANNOT create/rename/
 *           setMembers/archive; recruiter CAN write.
 *   Test 7: tenant isolation — another tenant's pool never leaks into the list.
 *   Test 8 (HONESTY): upsertInterviewPlan with a round carrying panelPoolId and
 *           EMPTY defaultPanelMembershipIds → the persisted plan row's
 *           default_panel_membership_ids == the pool's members AND panel_pool_id
 *           is set (the server COPIED from the pool). An override (panelPoolId +
 *           explicit ids) → keeps panel_pool_id but stores the overridden ids. A
 *           foreign OR archived panelPoolId → BAD_REQUEST.
 *
 * All rows carry a per-run suffix so repeat runs on the shared dev DB don't
 * collide; afterAll cleans up its own plan/pool rows + the synthetic tenant.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / hiringmanager1 / recruiter1).
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
const ADMIN = "admin1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// A synthetic second tenant (panel_pools has a REAL FK to tenants), used only to
// prove isolation + the foreign-pool rejection. beforeAll inserts it; afterAll
// removes its pools + the tenant row.
const OTHER_TENANT_ID = "00000000-0000-4000-8000-00000a33e999";
const FOREIGN_POOL_ID = "00000000-0000-4000-8000-00000a33e001";
// A membership id that is NOT an active membership in the caller's tenant — used
// to prove setPanelPoolMembers rejects a foreign/inactive membership.
const FOREIGN_MEMBERSHIP_ID = "00000000-0000-4000-8000-00000a33e002";

// Requisition fixture (poolSql-seeded) for the honesty plan tests.
const REQ_BU = "00000000-0000-4000-8000-00000a33eb01";
const REQ_POSITION = "00000000-0000-4000-8000-00000a33eb02";
const REQ_JD = "00000000-0000-4000-8000-00000a33eb03";
const REQ_ID = "00000000-0000-4000-8000-00000a33eb04";

const RUN = Date.now().toString(36);
const POOL_A = `T33 Pool A ${RUN}`;
const POOL_B = `T33 Pool B ${RUN}`;
const ARCHIVE_POOL = `T33 Archive ${RUN}`;
const HONESTY_POOL = `T33 Honesty ${RUN}`;
const HONESTY_ARCHIVE_POOL = `T33 Honesty Archive ${RUN}`;

let adminJwt: string;
let hmJwt: string;
let recruiterJwt: string;
let tenantId: string;
let recruiterMembershipId: string;
let hmMembershipId: string;

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

async function membershipIdFor(jwt: string): Promise<string> {
  const claims = decodeJwt(jwt);
  const userId = claims.sub as string;
  const tid = (claims as { tid?: string }).tid as string;
  const [m] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships
    WHERE user_id = ${userId} AND tenant_id = ${tid} AND status = 'active' LIMIT 1
  `;
  if (!m) throw new Error(`membership missing for ${userId}`);
  return m.id;
}

interface PoolRow {
  id: string;
  name: string;
  focus: string | null;
  isArchived: boolean;
  memberMembershipIds: string[];
}

let poolAId: string;
let archivePoolId: string;

describe("T3.3 / G16 panel-pool library", () => {
  beforeAll(async () => {
    [adminJwt, hmJwt, recruiterJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(HIRING_MANAGER),
      signIn(RECRUITER),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    recruiterMembershipId = await membershipIdFor(recruiterJwt);
    hmMembershipId = await membershipIdFor(hmJwt);

    // Mint the synthetic isolation tenant + a foreign pool (service-role, bypasses RLS).
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${OTHER_TENANT_ID}, ${"t33-other-" + RUN}, 'T33 Other Tenant',
              'ap-northeast-1', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.panel_pools (id, tenant_id, name, is_archived)
      VALUES (${FOREIGN_POOL_ID}, ${OTHER_TENANT_ID}, ${"T33 Foreign " + RUN}, false)
      ON CONFLICT (id) DO NOTHING
    `;

    // Requisition fixture for the honesty plan tests.
    await cleanupReqFixture();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${REQ_BU}, ${tenantId}, ${"T33 ReqBU " + RUN}, ${"t33-reqbu-" + RUN})`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${REQ_POSITION}, ${tenantId}, ${REQ_BU}, 'T33 Staff Engineer', 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${REQ_JD}, ${tenantId}, ${REQ_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ_ID}, ${tenantId}, ${REQ_POSITION}, ${REQ_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
    `;
  });

  async function cleanupReqFixture(): Promise<void> {
    await poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${REQ_ID}`;
    await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ_ID}`;
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${REQ_JD}`;
    await poolSql`DELETE FROM public.positions WHERE id = ${REQ_POSITION}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${REQ_BU}`;
  }

  afterAll(async () => {
    try {
      // interview_plans reference panel_pools via ON DELETE RESTRICT — drop the
      // plan rows (via the requisition + fixture) BEFORE the pools.
      await cleanupReqFixture();
      // This run's pools (members cascade). panel_pool_members membership-FK is
      // RESTRICT on the MEMBERSHIP, not the member row, so member rows drop fine.
      await poolSql`DELETE FROM public.panel_pools WHERE tenant_id = ${tenantId} AND name LIKE ${"T33 %" + RUN}`;
      await poolSql`DELETE FROM public.panel_pools WHERE tenant_id = ${OTHER_TENANT_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${OTHER_TENANT_ID}`;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: create (name + focus) + list rows carry members", async () => {
    const a = await trpcMutation<{ row: PoolRow }>(
      "createPanelPool",
      { name: POOL_A, focus: "Backend loop" },
      adminJwt,
    );
    assert.ok(!isErr(a), `create A: ${JSON.stringify(a)}`);
    assert.equal(a.result.data.row.name, POOL_A);
    assert.equal(a.result.data.row.focus, "Backend loop", "focus persisted");
    assert.equal(a.result.data.row.isArchived, false);
    assert.deepEqual(a.result.data.row.memberMembershipIds, [], "new pool has no members");
    poolAId = a.result.data.row.id;

    // recruiter can create too (write role).
    const b = await trpcMutation<{ row: PoolRow }>(
      "createPanelPool",
      { name: POOL_B },
      recruiterJwt,
    );
    assert.ok(!isErr(b), `create B (recruiter): ${JSON.stringify(b)}`);
    assert.equal(b.result.data.row.focus, null, "no focus → null");

    // Give pool A members, then confirm the list folds them.
    const set = await trpcMutation<{ row: PoolRow }>(
      "setPanelPoolMembers",
      { id: poolAId, membershipIds: [recruiterMembershipId, hmMembershipId] },
      adminJwt,
    );
    assert.ok(!isErr(set), `set members: ${JSON.stringify(set)}`);

    const list = await trpcQuery<{ rows: PoolRow[] }>("listPanelPools", {}, adminJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const rowA = list.result.data.rows.find((r) => r.id === poolAId);
    assert.ok(rowA, "pool A appears in the list");
    assert.equal(rowA!.memberMembershipIds.length, 2, "pool A carries its 2 members");
    assert.ok(
      rowA!.memberMembershipIds.includes(recruiterMembershipId) &&
        rowA!.memberMembershipIds.includes(hmMembershipId),
      "both members folded onto the row",
    );
  });

  it("Test 2: list excludes archived by default, includes with flag", async () => {
    const created = await trpcMutation<{ row: PoolRow }>(
      "createPanelPool",
      { name: ARCHIVE_POOL },
      adminJwt,
    );
    assert.ok(!isErr(created), `create archive pool: ${JSON.stringify(created)}`);
    archivePoolId = created.result.data.row.id;

    const archived = await trpcMutation<{ row: PoolRow }>(
      "setPanelPoolArchived",
      { id: archivePoolId, archived: true },
      adminJwt,
    );
    assert.ok(!isErr(archived), `archive: ${JSON.stringify(archived)}`);
    assert.equal(archived.result.data.row.isArchived, true);

    const def = await trpcQuery<{ rows: PoolRow[] }>("listPanelPools", {}, adminJwt);
    assert.ok(!isErr(def));
    assert.equal(
      def.result.data.rows.find((r) => r.id === archivePoolId),
      undefined,
      "archived pool hidden from default list",
    );

    const all = await trpcQuery<{ rows: PoolRow[] }>(
      "listPanelPools",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(all));
    assert.ok(
      all.result.data.rows.some((r) => r.id === archivePoolId),
      "archived pool visible with includeArchived",
    );
  });

  it("Test 3: rename changes name + focus", async () => {
    const renamed = `${POOL_B} (renamed)`;
    const res = await trpcMutation<{ row: PoolRow }>(
      "renamePanelPool",
      { id: poolAId, name: renamed, focus: "Leadership loop" },
      recruiterJwt,
    );
    assert.ok(!isErr(res), `rename: ${JSON.stringify(res)}`);
    assert.equal(res.result.data.row.name, renamed, "name updated");
    assert.equal(res.result.data.row.focus, "Leadership loop", "focus updated");
    // Rename preserves members.
    assert.equal(res.result.data.row.memberMembershipIds.length, 2, "members preserved on rename");
    // Rename back so later duplicate test is deterministic.
    await trpcMutation("renamePanelPool", { id: poolAId, name: POOL_A }, recruiterJwt);
  });

  it("Test 4: (tenant, name) duplicate rejected", async () => {
    const dup = await trpcMutation("createPanelPool", { name: POOL_A }, adminJwt);
    assert.ok(
      isErr(dup) && dup.error.data.code === "BAD_REQUEST",
      "(tenant, name) duplicate rejected",
    );
  });

  it("Test 5: setPanelPoolMembers replace-set + foreign/inactive membership rejected", async () => {
    // Replace-set down to a single member.
    const replaced = await trpcMutation<{ row: PoolRow }>(
      "setPanelPoolMembers",
      { id: poolAId, membershipIds: [recruiterMembershipId] },
      adminJwt,
    );
    assert.ok(!isErr(replaced), `replace: ${JSON.stringify(replaced)}`);
    assert.deepEqual(
      replaced.result.data.row.memberMembershipIds,
      [recruiterMembershipId],
      "roster replaced down to one member",
    );

    // A foreign/inactive membership is rejected.
    const bad = await trpcMutation(
      "setPanelPoolMembers",
      { id: poolAId, membershipIds: [recruiterMembershipId, FOREIGN_MEMBERSHIP_ID] },
      adminJwt,
    );
    assert.ok(
      isErr(bad) && bad.error.data.code === "BAD_REQUEST",
      "foreign/inactive membership rejected",
    );

    // Restore the full roster for the honesty tests below.
    await trpcMutation(
      "setPanelPoolMembers",
      { id: poolAId, membershipIds: [recruiterMembershipId, hmMembershipId] },
      adminJwt,
    );
  });

  it("Test 6: write gating — hm can list, cannot write; recruiter can write", async () => {
    const list = await trpcQuery("listPanelPools", {}, hmJwt);
    assert.ok(!isErr(list), "hiring_manager can list (read role)");

    const create = await trpcMutation("createPanelPool", { name: `T33 hm Nope ${RUN}` }, hmJwt);
    assert.ok(isErr(create) && create.error.data.code === "FORBIDDEN", "hm cannot create");

    const rename = await trpcMutation("renamePanelPool", { id: poolAId, name: POOL_A }, hmJwt);
    assert.ok(isErr(rename) && rename.error.data.code === "FORBIDDEN", "hm cannot rename");

    const setMembers = await trpcMutation(
      "setPanelPoolMembers",
      { id: poolAId, membershipIds: [] },
      hmJwt,
    );
    assert.ok(
      isErr(setMembers) && setMembers.error.data.code === "FORBIDDEN",
      "hm cannot set members",
    );

    const archive = await trpcMutation(
      "setPanelPoolArchived",
      { id: poolAId, archived: true },
      hmJwt,
    );
    assert.ok(isErr(archive) && archive.error.data.code === "FORBIDDEN", "hm cannot archive");

    // recruiter (write role) CAN create.
    const recCreate = await trpcMutation<{ row: PoolRow }>(
      "createPanelPool",
      { name: `T33 rec ok ${RUN}` },
      recruiterJwt,
    );
    assert.ok(!isErr(recCreate), `recruiter can create: ${JSON.stringify(recCreate)}`);
  });

  it("Test 7: tenant isolation — another tenant's pool never leaks", async () => {
    const list = await trpcQuery<{ rows: PoolRow[] }>(
      "listPanelPools",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    assert.equal(
      list.result.data.rows.find((r) => r.id === FOREIGN_POOL_ID),
      undefined,
      "another tenant's pool is not visible (tenant isolation)",
    );
  });

  it("Test 8 (HONESTY): the pool drives the round's panel; foreign/archived rejected; override kept", async () => {
    // A pool whose members the plan will copy.
    const honestyPool = await trpcMutation<{ row: PoolRow }>(
      "createPanelPool",
      { name: HONESTY_POOL },
      adminJwt,
    );
    assert.ok(!isErr(honestyPool), `create honesty pool: ${JSON.stringify(honestyPool)}`);
    const honestyPoolId = honestyPool.result.data.row.id;
    await trpcMutation(
      "setPanelPoolMembers",
      { id: honestyPoolId, membershipIds: [recruiterMembershipId, hmMembershipId] },
      adminJwt,
    );

    // 8a — panelPoolId + EMPTY defaultPanelMembershipIds → server COPIES members.
    const copyPlan = await trpcMutation<{ roundCount: number }>(
      "upsertInterviewPlan",
      {
        requisitionId: REQ_ID,
        rounds: [
          {
            roundNumber: 1,
            roundName: "Pool-driven round",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: ["system_design"],
            defaultPanelMembershipIds: [],
            panelPoolId: honestyPoolId,
          },
        ],
      },
      recruiterJwt,
    );
    assert.ok(!isErr(copyPlan), `copy plan: ${JSON.stringify(copyPlan)}`);
    const [copyRow] = await poolSql<
      { default_panel_membership_ids: string[]; panel_pool_id: string | null }[]
    >`
      SELECT default_panel_membership_ids, panel_pool_id
      FROM public.interview_plans
      WHERE requisition_id = ${REQ_ID} AND round_number = 1
    `;
    assert.equal(copyRow?.panel_pool_id, honestyPoolId, "panel_pool_id persisted (provenance)");
    assert.deepEqual(
      [...(copyRow?.default_panel_membership_ids ?? [])].sort(),
      [recruiterMembershipId, hmMembershipId].sort(),
      "server COPIED the pool's members into the round's default panel",
    );

    // 8b — override: panelPoolId + explicit ids → keeps pool_id, stores overridden ids.
    const overridePlan = await trpcMutation<{ roundCount: number }>(
      "upsertInterviewPlan",
      {
        requisitionId: REQ_ID,
        rounds: [
          {
            roundNumber: 1,
            roundName: "Override round",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: ["system_design"],
            defaultPanelMembershipIds: [recruiterMembershipId],
            panelPoolId: honestyPoolId,
          },
        ],
      },
      recruiterJwt,
    );
    assert.ok(!isErr(overridePlan), `override plan: ${JSON.stringify(overridePlan)}`);
    const [ovRow] = await poolSql<
      { default_panel_membership_ids: string[]; panel_pool_id: string | null }[]
    >`
      SELECT default_panel_membership_ids, panel_pool_id
      FROM public.interview_plans
      WHERE requisition_id = ${REQ_ID} AND round_number = 1
    `;
    assert.equal(ovRow?.panel_pool_id, honestyPoolId, "override keeps panel_pool_id (provenance)");
    assert.deepEqual(
      ovRow?.default_panel_membership_ids,
      [recruiterMembershipId],
      "override stores the overridden ids, NOT the full pool",
    );

    // 8c — a foreign panelPoolId → BAD_REQUEST.
    const foreign = await trpcMutation(
      "upsertInterviewPlan",
      {
        requisitionId: REQ_ID,
        rounds: [
          {
            roundNumber: 1,
            roundName: "Foreign pool round",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: [],
            defaultPanelMembershipIds: [],
            panelPoolId: FOREIGN_POOL_ID,
          },
        ],
      },
      recruiterJwt,
    );
    assert.ok(
      isErr(foreign) && foreign.error.data.code === "BAD_REQUEST",
      "foreign panelPoolId rejected",
    );

    // 8d — an archived panelPoolId → BAD_REQUEST.
    const archPool = await trpcMutation<{ row: PoolRow }>(
      "createPanelPool",
      { name: HONESTY_ARCHIVE_POOL },
      adminJwt,
    );
    assert.ok(!isErr(archPool), `create honesty archive pool: ${JSON.stringify(archPool)}`);
    const archPoolId = archPool.result.data.row.id;
    await trpcMutation("setPanelPoolArchived", { id: archPoolId, archived: true }, adminJwt);

    const onArchived = await trpcMutation(
      "upsertInterviewPlan",
      {
        requisitionId: REQ_ID,
        rounds: [
          {
            roundNumber: 1,
            roundName: "Archived pool round",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: [],
            defaultPanelMembershipIds: [],
            panelPoolId: archPoolId,
          },
        ],
      },
      recruiterJwt,
    );
    assert.ok(
      isErr(onArchived) && onArchived.error.data.code === "BAD_REQUEST",
      "archived panelPoolId rejected",
    );

    // Clear the plan so afterAll can drop the honesty pools (RESTRICT).
    await trpcMutation("upsertInterviewPlan", { requisitionId: REQ_ID, rounds: [] }, recruiterJwt);
  });
});
