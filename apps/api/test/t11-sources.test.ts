/**
 * T1.1 / G04 — the sourcing-channel registry (tenant_application_sources).
 *
 * Exercises the three CRUD procedures + RLS over real cloud-minted JWTs
 * (reality #110 — sign in as the seeded personas):
 *
 *   Test 1: upsertTenantSource (admin) writes a channel row; listTenantSources
 *           (admin) reads it back. Regenerate-safe: a second upsert on the same
 *           (tenant, source_enum) updates in place (still exactly one row).
 *   Test 2: setTenantSourceEnabled (admin) toggles the enabled flag.
 *   Test 3: read gating — recruiter CAN list (a read role); hr_head CANNOT
 *           (not a read role, FORBIDDEN).
 *   Test 4: write gating — recruiter FORBIDDEN on upsertTenantSource AND on
 *           setTenantSourceEnabled (writes are admin-only config).
 *   Test 5: tenant isolation — a registry row inserted under a DIFFERENT tenant
 *           (service-role insert, bypassing RLS) never appears in the
 *           kyndryl-poc admin's listTenantSources (RLS + tenant-scoped where).
 *
 * Uses the 'whatsapp' channel, which the t11 seed deliberately does NOT seed,
 * so the suite never clobbers seed data. Cleans up its own rows in afterAll.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1 / hrhead1).
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
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// A second, unrelated tenant seeded in the shared DB — used only to prove
// isolation. It is a synthetic tenant; we insert + remove one row under it.
const OTHER_TENANT_ID = "00000000-0000-4000-8000-00000a02e001";

// The channel this suite owns. NOT seeded by seed-t11-sources (disjoint).
const TEST_SOURCE = "whatsapp";

let recruiterJwt: string;
let hrHeadJwt: string;
let adminJwt: string;
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

interface SourceRow {
  id: string;
  sourceEnum: string;
  label: string;
  enabled: boolean;
  ingestionMode: string;
}

describe("T1.1 / G04 sourcing-channel registry", () => {
  beforeAll(async () => {
    [recruiterJwt, hrHeadJwt, adminJwt] = await Promise.all([
      signIn(RECRUITER),
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
      await poolSql`
        DELETE FROM public.tenant_application_sources
        WHERE tenant_id = ${tenantId} AND source_enum = ${TEST_SOURCE}::application_source
      `;
      await poolSql`
        DELETE FROM public.tenant_application_sources
        WHERE tenant_id = ${OTHER_TENANT_ID} AND source_enum = 'talent_pool'::application_source
      `;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
  });

  it("Test 1: upsertTenantSource (admin) + listTenantSources round-trip + idempotent update", async () => {
    const up = await trpcMutation<{ row: SourceRow }>(
      "upsertTenantSource",
      {
        sourceEnum: TEST_SOURCE,
        label: "WhatsApp intake",
        enabled: true,
        ingestionMode: "connector_pending",
        config: { detail: "+91-99999-00000" },
        notes: "t11 test channel",
      },
      adminJwt,
    );
    assert.ok(!isErr(up), `upsert: ${JSON.stringify(up)}`);
    assert.equal(up.result.data.row.label, "WhatsApp intake");
    assert.equal(up.result.data.row.ingestionMode, "connector_pending");

    const list = await trpcQuery<{ rows: SourceRow[] }>("listTenantSources", {}, adminJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const mine = list.result.data.rows.find((r) => r.sourceEnum === TEST_SOURCE);
    assert.ok(mine, "seeded channel appears for admin");
    assert.equal(mine!.label, "WhatsApp intake");

    // Idempotent update — relabel, expect still exactly one row.
    const up2 = await trpcMutation(
      "upsertTenantSource",
      {
        sourceEnum: TEST_SOURCE,
        label: "WhatsApp (business)",
        enabled: true,
        ingestionMode: "manual",
        config: {},
        notes: null,
      },
      adminJwt,
    );
    assert.ok(!isErr(up2), `upsert2: ${JSON.stringify(up2)}`);
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_application_sources
      WHERE tenant_id = ${tenantId} AND source_enum = ${TEST_SOURCE}::application_source
    `;
    assert.equal(Number(n), 1, "still exactly one row (upsert replaced)");
    const [{ label } = { label: "" }] = await poolSql<{ label: string }[]>`
      SELECT label FROM public.tenant_application_sources
      WHERE tenant_id = ${tenantId} AND source_enum = ${TEST_SOURCE}::application_source
    `;
    assert.equal(label, "WhatsApp (business)", "label updated in place");
  });

  it("Test 2: setTenantSourceEnabled (admin) toggles enabled", async () => {
    const list = await trpcQuery<{ rows: SourceRow[] }>("listTenantSources", {}, adminJwt);
    assert.ok(!isErr(list));
    const row = list.result.data.rows.find((r) => r.sourceEnum === TEST_SOURCE);
    assert.ok(row, "test channel exists");

    const off = await trpcMutation<{ row: SourceRow }>(
      "setTenantSourceEnabled",
      { id: row!.id, enabled: false },
      adminJwt,
    );
    assert.ok(!isErr(off), `disable: ${JSON.stringify(off)}`);
    assert.equal(off.result.data.row.enabled, false, "channel disabled");

    const on = await trpcMutation<{ row: SourceRow }>(
      "setTenantSourceEnabled",
      { id: row!.id, enabled: true },
      adminJwt,
    );
    assert.ok(!isErr(on), `enable: ${JSON.stringify(on)}`);
    assert.equal(on.result.data.row.enabled, true, "channel re-enabled");
  });

  it("Test 3: read gating — recruiter CAN list, hr_head CANNOT", async () => {
    const asRecruiter = await trpcQuery("listTenantSources", {}, recruiterJwt);
    assert.ok(!isErr(asRecruiter), "recruiter can read the registry");

    const asHrHead = await trpcQuery("listTenantSources", {}, hrHeadJwt);
    assert.ok(
      isErr(asHrHead) && asHrHead.error.data.code === "FORBIDDEN",
      "hr_head cannot read the registry (not a read role)",
    );
  });

  it("Test 4: write gating — recruiter FORBIDDEN on upsert AND setEnabled", async () => {
    const write = await trpcMutation(
      "upsertTenantSource",
      {
        sourceEnum: TEST_SOURCE,
        label: "hacked",
        enabled: true,
        ingestionMode: "manual",
        config: {},
        notes: null,
      },
      recruiterJwt,
    );
    assert.ok(
      isErr(write) && write.error.data.code === "FORBIDDEN",
      "recruiter cannot upsert a channel",
    );

    // Grab a real id as admin, then confirm recruiter cannot toggle it.
    const list = await trpcQuery<{ rows: SourceRow[] }>("listTenantSources", {}, adminJwt);
    assert.ok(!isErr(list));
    const row = list.result.data.rows.find((r) => r.sourceEnum === TEST_SOURCE);
    assert.ok(row, "test channel exists");
    const toggle = await trpcMutation(
      "setTenantSourceEnabled",
      { id: row!.id, enabled: false },
      recruiterJwt,
    );
    assert.ok(
      isErr(toggle) && toggle.error.data.code === "FORBIDDEN",
      "recruiter cannot toggle a channel",
    );
  });

  it("Test 5: tenant isolation — another tenant's channel never leaks into the list", async () => {
    // Service-role insert (bypasses RLS) under a DIFFERENT tenant.
    await poolSql`
      INSERT INTO public.tenant_application_sources
        (tenant_id, source_enum, label, enabled, ingestion_mode, config, updated_at)
      VALUES
        (${OTHER_TENANT_ID}, 'talent_pool'::application_source, 'OTHER-TENANT LEAK PROBE',
         true, 'manual', '{}'::jsonb, now())
      ON CONFLICT (tenant_id, source_enum) DO UPDATE SET label = EXCLUDED.label
    `;

    const list = await trpcQuery<{ rows: SourceRow[] }>("listTenantSources", {}, adminJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const leaked = list.result.data.rows.find((r) => r.label === "OTHER-TENANT LEAK PROBE");
    assert.equal(leaked, undefined, "another tenant's channel is not visible (tenant isolation)");
  });
});
