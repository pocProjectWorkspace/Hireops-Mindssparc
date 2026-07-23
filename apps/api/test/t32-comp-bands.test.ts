/**
 * T3.2 / G15 — comp-band library (org structure).
 *
 * Exercises the four management procedures + the HONESTY wiring into
 * createRequisitionDraft, over real cloud-minted JWTs (reality #110 — sign in as
 * the seeded personas):
 *
 *   Test 1: createCompBand (with + without a level) + listCompBands rows.
 *   Test 2: list excludes archived by default, includes with the flag; archive
 *           excludes from the default list.
 *   Test 3: updateCompBand changes min/max.
 *   Test 4: min ≤ max rejected on create AND update (BAD_REQUEST); (tenant,name)
 *           duplicate rejected (BAD_REQUEST).
 *   Test 5: write gating — hiring_manager + recruiter CAN list, CANNOT create /
 *           update / archive; read gating holds.
 *   Test 6: tenant isolation — another tenant's band never leaks into the list.
 *   Test 7 (HONESTY): createRequisitionDraft with a compBandId and NO explicit
 *           compBandMin/Max → the position's comp_band_id == the band AND
 *           comp_band_min/max == the band's min/max (the server COPIED from the
 *           band). A foreign / archived compBandId → BAD_REQUEST. An explicit
 *           override (compBandId + differing min/max) → the position keeps
 *           comp_band_id but stores the overridden values.
 *
 * All rows carry a per-run suffix so repeat runs on the shared dev DB don't
 * collide; afterAll cleans up its own requisition chains + bands + the synthetic
 * tenant.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / hrhead1 / hiringmanager1 /
 * recruiter1).
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
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// A synthetic second tenant (comp_bands has a REAL FK to tenants), used only to
// prove isolation + the foreign-band rejection. beforeAll inserts it; afterAll
// removes its bands + the tenant row.
const OTHER_TENANT_ID = "00000000-0000-4000-8000-00000a32e999";
const FOREIGN_BAND_ID = "00000000-0000-4000-8000-00000a32e001";

const RUN = Date.now().toString(36);
const BAND_A = `T32 Band A ${RUN}`;
const BAND_B = `T32 Band B ${RUN}`;
const ARCHIVE_BAND = `T32 Archive ${RUN}`;
const COPY_BAND = `T32 Copy ${RUN}`;
const OVERRIDE_BAND = `T32 Override ${RUN}`;
const REQ_BU_NAME = `T32 ReqBU ${RUN}`;

let adminJwt: string;
let hrHeadJwt: string;
let hmJwt: string;
let recruiterJwt: string;
let tenantId: string;
const reqIds: string[] = [];

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

interface BandRow {
  id: string;
  name: string;
  level: string | null;
  currency: string;
  minMajor: number;
  maxMajor: number;
  isArchived: boolean;
}

let bandAId: string;
let archiveBandId: string;

describe("T3.2 / G15 comp-band library", () => {
  beforeAll(async () => {
    [adminJwt, hrHeadJwt, hmJwt, recruiterJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(HR_HEAD),
      signIn(HIRING_MANAGER),
      signIn(RECRUITER),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // Mint the synthetic isolation tenant (service-role insert, bypasses RLS).
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${OTHER_TENANT_ID}, ${"t32-other-" + RUN}, 'T32 Other Tenant',
              'ap-northeast-1', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.comp_bands (id, tenant_id, name, currency, min_major, max_major, is_archived)
      VALUES (${FOREIGN_BAND_ID}, ${OTHER_TENANT_ID}, ${"T32 Foreign " + RUN}, 'INR', 1000000, 2000000, false)
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    try {
      // Requisition chains first (positions FK the comp bands via comp_band_id).
      for (const reqId of reqIds) {
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
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId} AND name LIKE ${"T32 %" + RUN}`;
      // This run's bands (positions are gone, so RESTRICT is satisfied).
      await poolSql`DELETE FROM public.comp_bands WHERE tenant_id = ${tenantId} AND name LIKE ${"T32 %" + RUN}`;
      await poolSql`DELETE FROM public.comp_bands WHERE tenant_id = ${OTHER_TENANT_ID}`;
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

  it("Test 1: create (with + without level) + list rows", async () => {
    const a = await trpcMutation<{ row: BandRow }>(
      "createCompBand",
      { name: BAND_A, currency: "INR", minMajor: 2000000, maxMajor: 3000000 },
      adminJwt,
    );
    assert.ok(!isErr(a), `create A: ${JSON.stringify(a)}`);
    assert.equal(a.result.data.row.name, BAND_A);
    assert.equal(a.result.data.row.level, null, "no level → null");
    assert.equal(a.result.data.row.minMajor, 2000000);
    assert.equal(a.result.data.row.maxMajor, 3000000);
    assert.equal(a.result.data.row.isArchived, false);
    bandAId = a.result.data.row.id;

    // hr_head can create too (write role).
    const b = await trpcMutation<{ row: BandRow }>(
      "createCompBand",
      { name: BAND_B, level: "P4", currency: "INR", minMajor: 3500000, maxMajor: 5000000 },
      hrHeadJwt,
    );
    assert.ok(!isErr(b), `create B (hr_head): ${JSON.stringify(b)}`);
    assert.equal(b.result.data.row.level, "P4", "level persisted");

    const list = await trpcQuery<{ rows: BandRow[] }>("listCompBands", {}, adminJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    assert.ok(
      list.result.data.rows.some((r) => r.id === bandAId),
      "band A appears in the list",
    );
    assert.ok(
      list.result.data.rows.some((r) => r.name === BAND_B),
      "band B appears in the list",
    );
  });

  it("Test 2: list excludes archived by default, includes with flag", async () => {
    const created = await trpcMutation<{ row: BandRow }>(
      "createCompBand",
      { name: ARCHIVE_BAND, currency: "INR", minMajor: 1000000, maxMajor: 1500000 },
      adminJwt,
    );
    assert.ok(!isErr(created), `create archive band: ${JSON.stringify(created)}`);
    archiveBandId = created.result.data.row.id;

    const archived = await trpcMutation<{ row: BandRow }>(
      "setCompBandArchived",
      { id: archiveBandId, archived: true },
      adminJwt,
    );
    assert.ok(!isErr(archived), `archive: ${JSON.stringify(archived)}`);
    assert.equal(archived.result.data.row.isArchived, true);

    const def = await trpcQuery<{ rows: BandRow[] }>("listCompBands", {}, adminJwt);
    assert.ok(!isErr(def));
    assert.equal(
      def.result.data.rows.find((r) => r.id === archiveBandId),
      undefined,
      "archived band hidden from default list",
    );

    const all = await trpcQuery<{ rows: BandRow[] }>(
      "listCompBands",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(all));
    assert.ok(
      all.result.data.rows.some((r) => r.id === archiveBandId),
      "archived band visible with includeArchived",
    );
  });

  it("Test 3: update changes min/max", async () => {
    const res = await trpcMutation<{ row: BandRow }>(
      "updateCompBand",
      { id: bandAId, name: BAND_A, currency: "INR", minMajor: 2200000, maxMajor: 3300000 },
      hrHeadJwt,
    );
    assert.ok(!isErr(res), `update: ${JSON.stringify(res)}`);
    assert.equal(res.result.data.row.minMajor, 2200000, "min updated");
    assert.equal(res.result.data.row.maxMajor, 3300000, "max updated");
  });

  it("Test 4: min ≤ max rejected (create + update); duplicate name rejected", async () => {
    const badCreate = await trpcMutation(
      "createCompBand",
      { name: `T32 Bad ${RUN}`, currency: "INR", minMajor: 5000000, maxMajor: 1000000 },
      adminJwt,
    );
    assert.ok(
      isErr(badCreate) && badCreate.error.data.code === "BAD_REQUEST",
      "min > max rejected on create",
    );

    const badUpdate = await trpcMutation(
      "updateCompBand",
      { id: bandAId, name: BAND_A, currency: "INR", minMajor: 9000000, maxMajor: 1000000 },
      adminJwt,
    );
    assert.ok(
      isErr(badUpdate) && badUpdate.error.data.code === "BAD_REQUEST",
      "min > max rejected on update",
    );

    const dup = await trpcMutation(
      "createCompBand",
      { name: BAND_A, currency: "INR", minMajor: 100000, maxMajor: 200000 },
      adminJwt,
    );
    assert.ok(
      isErr(dup) && dup.error.data.code === "BAD_REQUEST",
      "(tenant, name) duplicate rejected",
    );
  });

  it("Test 5: write gating — hm/recruiter can list, cannot create/update/archive", async () => {
    for (const [label, jwt] of [
      ["hiring_manager", hmJwt],
      ["recruiter", recruiterJwt],
    ] as const) {
      const list = await trpcQuery("listCompBands", {}, jwt);
      assert.ok(!isErr(list), `${label} can list (read role)`);

      const create = await trpcMutation(
        "createCompBand",
        { name: `T32 ${label} Nope ${RUN}`, currency: "INR", minMajor: 1, maxMajor: 2 },
        jwt,
      );
      assert.ok(isErr(create) && create.error.data.code === "FORBIDDEN", `${label} cannot create`);

      const update = await trpcMutation(
        "updateCompBand",
        { id: bandAId, name: BAND_A, currency: "INR", minMajor: 1, maxMajor: 2 },
        jwt,
      );
      assert.ok(isErr(update) && update.error.data.code === "FORBIDDEN", `${label} cannot update`);

      const archive = await trpcMutation(
        "setCompBandArchived",
        { id: bandAId, archived: true },
        jwt,
      );
      assert.ok(
        isErr(archive) && archive.error.data.code === "FORBIDDEN",
        `${label} cannot archive`,
      );
    }
  });

  it("Test 6: tenant isolation — another tenant's band never leaks", async () => {
    const list = await trpcQuery<{ rows: BandRow[] }>(
      "listCompBands",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    assert.equal(
      list.result.data.rows.find((r) => r.id === FOREIGN_BAND_ID),
      undefined,
      "another tenant's band is not visible (tenant isolation)",
    );
  });

  it("Test 7 (HONESTY): compBandId drives the position's comp; foreign/archived rejected; override kept", async () => {
    // A managed business unit to attach the positions to.
    const bu = await trpcMutation<{ row: { id: string } }>(
      "createBusinessUnit",
      { name: REQ_BU_NAME },
      adminJwt,
    );
    assert.ok(!isErr(bu), `create BU: ${JSON.stringify(bu)}`);
    const buId = bu.result.data.row.id;

    // A band the draft will copy from.
    const copyBand = await trpcMutation<{ row: BandRow }>(
      "createCompBand",
      { name: COPY_BAND, currency: "INR", minMajor: 2800000, maxMajor: 4200000 },
      adminJwt,
    );
    assert.ok(!isErr(copyBand), `create copy band: ${JSON.stringify(copyBand)}`);
    const copyBandId = copyBand.result.data.row.id;

    // 7a — compBandId with NO explicit min/max → server COPIES from the band.
    const copyDraft = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      {
        title: `T32 Copy Eng ${RUN}`,
        businessUnitId: buId,
        locationType: "onsite",
        compBandId: copyBandId,
      },
      adminJwt,
    );
    assert.ok(!isErr(copyDraft), `copy draft: ${JSON.stringify(copyDraft)}`);
    reqIds.push(copyDraft.result.data.requisitionId);
    const [copyPos] = await poolSql<
      {
        comp_band_id: string | null;
        comp_band_min: string | null;
        comp_band_max: string | null;
        comp_currency: string | null;
      }[]
    >`
      SELECT p.comp_band_id, p.comp_band_min, p.comp_band_max, p.comp_currency
      FROM public.positions p
      JOIN public.requisitions r ON r.position_id = p.id
      WHERE r.id = ${copyDraft.result.data.requisitionId}
    `;
    assert.equal(copyPos?.comp_band_id, copyBandId, "position linked to the band (provenance)");
    assert.equal(Number(copyPos?.comp_band_min), 2800000, "server COPIED the band's min");
    assert.equal(Number(copyPos?.comp_band_max), 4200000, "server COPIED the band's max");
    assert.equal(copyPos?.comp_currency, "INR", "server COPIED the band's currency");

    // 7b — foreign band id → BAD_REQUEST (RLS scopes it out).
    const foreign = await trpcMutation(
      "createRequisitionDraft",
      {
        title: `T32 Foreign Eng ${RUN}`,
        businessUnitId: buId,
        locationType: "onsite",
        compBandId: FOREIGN_BAND_ID,
      },
      adminJwt,
    );
    assert.ok(isErr(foreign) && foreign.error.data.code === "BAD_REQUEST", "foreign band rejected");

    // 7c — archived band id → BAD_REQUEST.
    const onArchived = await trpcMutation(
      "createRequisitionDraft",
      {
        title: `T32 Archived Eng ${RUN}`,
        businessUnitId: buId,
        locationType: "onsite",
        compBandId: archiveBandId,
      },
      adminJwt,
    );
    assert.ok(
      isErr(onArchived) && onArchived.error.data.code === "BAD_REQUEST",
      "archived band rejected",
    );

    // 7d — explicit override (compBandId + differing min/max) → keeps the band id
    // as provenance but stores the OVERRIDDEN values.
    const overrideBand = await trpcMutation<{ row: BandRow }>(
      "createCompBand",
      { name: OVERRIDE_BAND, currency: "INR", minMajor: 2000000, maxMajor: 3000000 },
      adminJwt,
    );
    assert.ok(!isErr(overrideBand), `create override band: ${JSON.stringify(overrideBand)}`);
    const overrideBandId = overrideBand.result.data.row.id;

    const overrideDraft = await trpcMutation<{ requisitionId: string }>(
      "createRequisitionDraft",
      {
        title: `T32 Override Eng ${RUN}`,
        businessUnitId: buId,
        locationType: "onsite",
        compBandId: overrideBandId,
        compBandMin: 2500000,
        compBandMax: 3600000,
        compCurrency: "INR",
      },
      adminJwt,
    );
    assert.ok(!isErr(overrideDraft), `override draft: ${JSON.stringify(overrideDraft)}`);
    reqIds.push(overrideDraft.result.data.requisitionId);
    const [ovPos] = await poolSql<
      { comp_band_id: string | null; comp_band_min: string | null; comp_band_max: string | null }[]
    >`
      SELECT p.comp_band_id, p.comp_band_min, p.comp_band_max
      FROM public.positions p
      JOIN public.requisitions r ON r.position_id = p.id
      WHERE r.id = ${overrideDraft.result.data.requisitionId}
    `;
    assert.equal(ovPos?.comp_band_id, overrideBandId, "override keeps the band id (provenance)");
    assert.equal(Number(ovPos?.comp_band_min), 2500000, "override stores the overridden min");
    assert.equal(Number(ovPos?.comp_band_max), 3600000, "override stores the overridden max");
  });
});
