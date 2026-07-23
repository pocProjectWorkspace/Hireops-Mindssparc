/**
 * T3.1 / G14 — business-unit management (org structure).
 *
 * Exercises the five management procedures + the honesty wiring into
 * createRequisitionDraft, over real cloud-minted JWTs (reality #110 — sign in as
 * the seeded personas):
 *
 *   Test 1: createBusinessUnit (with + without parent) + listBusinessUnits flat
 *           rows (the UI builds the tree) — the child sits under the parent.
 *   Test 2: renameBusinessUnit changes the NAME; the slug stays immutable.
 *   Test 3: reparentBusinessUnit success — a grandchild moves under the root.
 *   Test 4: reparent cycle guard — self-parent AND descendant-parent both
 *           BAD_REQUEST.
 *   Test 5: createRequisitionDraft with businessUnitId attaches the position to
 *           THAT managed unit (no ad-hoc unit created); a foreign / archived unit
 *           is rejected; archiving excludes the unit from the default list yet the
 *           position already on it stays valid.
 *   Test 6: admin gating — hiring_manager CAN list, CANNOT create / rename /
 *           reparent / archive.
 *   Test 7: tenant isolation — another tenant's unit never appears in the list.
 *
 * All rows carry a per-run suffix so repeat runs on the shared dev DB don't
 * collide; afterAll cleans up its own requisition chain + units.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / hiringmanager1 / recruiter1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
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
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// A synthetic second tenant, minted in beforeAll (business_units has a REAL FK
// to tenants, unlike tenant_application_sources), used only to prove isolation.
// beforeAll inserts it; afterAll removes its units + the tenant row.
const OTHER_TENANT_ID = "00000000-0000-4000-8000-00000a31e999";

const RUN = Date.now().toString(36);
const PARENT_NAME = `T31 Parent ${RUN}`;
const CHILD_NAME = `T31 Child ${RUN}`;
const GRANDCHILD_NAME = `T31 Grandchild ${RUN}`;
const REQ_BU_NAME = `T31 ReqBU ${RUN}`;
const REQ_TITLE = `T31 Engineer ${RUN}`;
const FOREIGN_BU_ID = "00000000-0000-4000-8000-00000a31e001";

let adminJwt: string;
let hmJwt: string;
let tenantId: string;
let reqId: string | null = null;

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

interface BuRow {
  id: string;
  parentBusinessUnitId: string | null;
  name: string;
  slug: string;
  isArchived: boolean;
}

let parentId: string;
let childId: string;
let grandchildId: string;
let reqBuId: string;

describe("T3.1 / G14 business-unit management", () => {
  beforeAll(async () => {
    [adminJwt, hmJwt] = await Promise.all([signIn(ADMIN), signIn(HIRING_MANAGER)]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // Mint the synthetic isolation tenant (service-role insert, bypasses RLS).
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${OTHER_TENANT_ID}, ${"t31-other-" + RUN}, 'T31 Other Tenant',
              'ap-northeast-1', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    try {
      // Requisition chain first (positions FK the business units).
      if (reqId) {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${reqId}
        `;
        await poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId} AND subject_id = ${reqId}`;
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${reqId}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${reqId}`;
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      }
      // This run's units (self-FK is ON DELETE SET NULL, so order-agnostic).
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name LIKE ${"T31 %" + RUN}`;
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${OTHER_TENANT_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${OTHER_TENANT_ID}`;
      await poolSql`
        DELETE FROM public.approval_chains c
        WHERE c.tenant_id = ${tenantId}
          AND NOT EXISTS (SELECT 1 FROM public.approval_requests r WHERE r.chain_id = c.id)
          AND c.created_at >= now() - interval '30 minutes'
      `;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
  });

  it("Test 1: create (with + without parent) + list flat rows (child under parent)", async () => {
    const parent = await trpcMutation<{ row: BuRow }>(
      "createBusinessUnit",
      { name: PARENT_NAME },
      adminJwt,
    );
    assert.ok(!isErr(parent), `create parent: ${JSON.stringify(parent)}`);
    assert.equal(parent.result.data.row.name, PARENT_NAME);
    assert.equal(parent.result.data.row.parentBusinessUnitId, null, "root has no parent");
    assert.equal(parent.result.data.row.isArchived, false);
    parentId = parent.result.data.row.id;

    const child = await trpcMutation<{ row: BuRow }>(
      "createBusinessUnit",
      { name: CHILD_NAME, parentBusinessUnitId: parentId },
      adminJwt,
    );
    assert.ok(!isErr(child), `create child: ${JSON.stringify(child)}`);
    assert.equal(child.result.data.row.parentBusinessUnitId, parentId, "child under parent");
    childId = child.result.data.row.id;

    const list = await trpcQuery<{ rows: BuRow[] }>("listBusinessUnits", {}, adminJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const p = list.result.data.rows.find((r) => r.id === parentId);
    const c = list.result.data.rows.find((r) => r.id === childId);
    assert.ok(p && c, "both units appear in the flat list");
    assert.equal(
      c!.parentBusinessUnitId,
      parentId,
      "flat row carries the parent id (UI builds tree)",
    );
  });

  it("Test 2: rename changes the name, slug stays immutable", async () => {
    const before = await trpcQuery<{ rows: BuRow[] }>("listBusinessUnits", {}, adminJwt);
    assert.ok(!isErr(before));
    const original = before.result.data.rows.find((r) => r.id === childId);
    assert.ok(original, "child exists");
    const originalSlug = original!.slug;

    const renamed = `${CHILD_NAME} Renamed`;
    const res = await trpcMutation<{ row: BuRow }>(
      "renameBusinessUnit",
      { id: childId, name: renamed },
      adminJwt,
    );
    assert.ok(!isErr(res), `rename: ${JSON.stringify(res)}`);
    assert.equal(res.result.data.row.name, renamed, "name updated");
    assert.equal(res.result.data.row.slug, originalSlug, "slug unchanged (immutable)");
  });

  it("Test 3: reparent success — grandchild moves under the root", async () => {
    const gc = await trpcMutation<{ row: BuRow }>(
      "createBusinessUnit",
      { name: GRANDCHILD_NAME, parentBusinessUnitId: childId },
      adminJwt,
    );
    assert.ok(!isErr(gc), `create grandchild: ${JSON.stringify(gc)}`);
    grandchildId = gc.result.data.row.id;
    assert.equal(gc.result.data.row.parentBusinessUnitId, childId);

    const moved = await trpcMutation<{ row: BuRow }>(
      "reparentBusinessUnit",
      { id: grandchildId, parentBusinessUnitId: parentId },
      adminJwt,
    );
    assert.ok(!isErr(moved), `reparent: ${JSON.stringify(moved)}`);
    assert.equal(moved.result.data.row.parentBusinessUnitId, parentId, "grandchild now under root");
  });

  it("Test 4: reparent cycle guard — self-parent AND descendant-parent rejected", async () => {
    const selfParent = await trpcMutation(
      "reparentBusinessUnit",
      { id: parentId, parentBusinessUnitId: parentId },
      adminJwt,
    );
    assert.ok(
      isErr(selfParent) && selfParent.error.data.code === "BAD_REQUEST",
      "self-parent rejected",
    );

    // child is a descendant of parent → making parent a child of `child` is a cycle.
    const descendantParent = await trpcMutation(
      "reparentBusinessUnit",
      { id: parentId, parentBusinessUnitId: childId },
      adminJwt,
    );
    assert.ok(
      isErr(descendantParent) && descendantParent.error.data.code === "BAD_REQUEST",
      "descendant-parent rejected (cycle)",
    );
  });

  it("Test 5: createRequisitionDraft uses the picked unit; foreign/archived rejected; archive keeps positions valid", async () => {
    const bu = await trpcMutation<{ row: BuRow }>(
      "createBusinessUnit",
      { name: REQ_BU_NAME },
      adminJwt,
    );
    assert.ok(!isErr(bu), `create req BU: ${JSON.stringify(bu)}`);
    reqBuId = bu.result.data.row.id;

    const draft = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      { title: REQ_TITLE, businessUnitId: reqBuId, locationType: "onsite" },
      adminJwt,
    );
    assert.ok(!isErr(draft), `create draft: ${JSON.stringify(draft)}`);
    reqId = draft.result.data.requisitionId;

    // The position is attached to EXACTLY the picked unit — proving the draft
    // used the supplied businessUnitId and did NOT invent an ad-hoc unit (the
    // draft carried no `department`, so the resolve-or-create path never ran).
    const [pos] = await poolSql<{ business_unit_id: string }[]>`
      SELECT p.business_unit_id
      FROM public.positions p
      JOIN public.requisitions r ON r.position_id = p.id
      WHERE r.id = ${reqId}
    `;
    assert.equal(pos?.business_unit_id, reqBuId, "position attached to the picked unit");

    // Foreign unit (another tenant) — RLS scopes it out, so it's "not found".
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug, is_archived)
      VALUES (${FOREIGN_BU_ID}, ${OTHER_TENANT_ID}, ${"T31 Foreign " + RUN}, ${"t31-foreign-" + RUN}, false)
      ON CONFLICT (id) DO NOTHING
    `;
    const foreign = await trpcMutation(
      "createRequisitionDraft",
      { title: `${REQ_TITLE} foreign`, businessUnitId: FOREIGN_BU_ID, locationType: "onsite" },
      adminJwt,
    );
    assert.ok(isErr(foreign) && foreign.error.data.code === "BAD_REQUEST", "foreign unit rejected");

    // Archive the req BU (it already has a position on it).
    const archived = await trpcMutation<{ row: BuRow }>(
      "setBusinessUnitArchived",
      { id: reqBuId, archived: true },
      adminJwt,
    );
    assert.ok(!isErr(archived), `archive: ${JSON.stringify(archived)}`);
    assert.equal(archived.result.data.row.isArchived, true);

    // Default list excludes it; includeArchived shows it.
    const def = await trpcQuery<{ rows: BuRow[] }>("listBusinessUnits", {}, adminJwt);
    assert.ok(!isErr(def));
    assert.equal(
      def.result.data.rows.find((r) => r.id === reqBuId),
      undefined,
      "archived unit hidden from default list",
    );
    const all = await trpcQuery<{ rows: BuRow[] }>(
      "listBusinessUnits",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(all));
    assert.ok(
      all.result.data.rows.some((r) => r.id === reqBuId),
      "archived unit visible with includeArchived",
    );

    // The position already on the archived unit stays valid (FK intact).
    const [stillThere] = await poolSql<{ business_unit_id: string }[]>`
      SELECT p.business_unit_id
      FROM public.positions p
      JOIN public.requisitions r ON r.position_id = p.id
      WHERE r.id = ${reqId}
    `;
    assert.equal(stillThere?.business_unit_id, reqBuId, "existing position unaffected by archive");

    // A new draft on the archived unit is rejected.
    const onArchived = await trpcMutation(
      "createRequisitionDraft",
      { title: `${REQ_TITLE} archived`, businessUnitId: reqBuId, locationType: "onsite" },
      adminJwt,
    );
    assert.ok(
      isErr(onArchived) && onArchived.error.data.code === "BAD_REQUEST",
      "archived unit rejected for new drafts",
    );
  });

  it("Test 6: admin gating — hiring_manager can list, cannot create/rename/reparent/archive", async () => {
    const list = await trpcQuery("listBusinessUnits", {}, hmJwt);
    assert.ok(!isErr(list), "hiring_manager can list (read role)");

    const create = await trpcMutation("createBusinessUnit", { name: `T31 HM Nope ${RUN}` }, hmJwt);
    assert.ok(isErr(create) && create.error.data.code === "FORBIDDEN", "hm cannot create");

    const rename = await trpcMutation(
      "renameBusinessUnit",
      { id: parentId, name: "hacked" },
      hmJwt,
    );
    assert.ok(isErr(rename) && rename.error.data.code === "FORBIDDEN", "hm cannot rename");

    const reparent = await trpcMutation(
      "reparentBusinessUnit",
      { id: childId, parentBusinessUnitId: null },
      hmJwt,
    );
    assert.ok(isErr(reparent) && reparent.error.data.code === "FORBIDDEN", "hm cannot reparent");

    const archive = await trpcMutation(
      "setBusinessUnitArchived",
      { id: parentId, archived: true },
      hmJwt,
    );
    assert.ok(isErr(archive) && archive.error.data.code === "FORBIDDEN", "hm cannot archive");
  });

  it("Test 7: tenant isolation — another tenant's unit never leaks into the list", async () => {
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug, is_archived)
      VALUES (${FOREIGN_BU_ID}, ${OTHER_TENANT_ID}, ${"T31 Foreign " + RUN}, ${"t31-foreign-" + RUN}, false)
      ON CONFLICT (id) DO NOTHING
    `;
    const list = await trpcQuery<{ rows: BuRow[] }>(
      "listBusinessUnits",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    assert.equal(
      list.result.data.rows.find((r) => r.id === FOREIGN_BU_ID),
      undefined,
      "another tenant's unit is not visible (tenant isolation)",
    );
  });
});
