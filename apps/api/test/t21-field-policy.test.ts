/**
 * T2.1 / G05 — configurable required-candidate-field policy (candidate_field_policy).
 *
 * Exercises the three config procedures over real cloud-minted JWTs (reality
 * #110 — sign in as the seeded personas), against the SEVEN-field Missing Info
 * catalog (apps/api/src/lib/missing-info.ts):
 *
 *   Test 1: getCandidateFieldPolicy (admin) returns all 7 catalog fields with
 *           code-owned label + dataSource + default*; upsertCandidateFieldPolicy
 *           (admin) saves an override; get reflects it (isConfigured=true).
 *           Regenerate-safe: a second upsert on the same (tenant, fieldKey)
 *           updates in place.
 *   Test 2: resetCandidateFieldPolicy (admin) removes the row → the field falls
 *           back to the code default (isConfigured=false).
 *   Test 3: read gating — getCandidateFieldPolicy is admin-only config; recruiter
 *           and hr_head are FORBIDDEN.
 *   Test 4: write gating — recruiter FORBIDDEN on upsert AND reset.
 *   Test 5: validation — an unknown fieldKey and an invalid blocksAdvanceStage
 *           are rejected before the procedure runs (BAD_REQUEST).
 *
 * ENFORCEMENT NOTE (honesty): the configured gate is enforced in
 * transitionApplicationStage via candidateFieldPolicyAdvanceBlock (a forward move
 * to a stage a missing REQUIRED field gates is refused with BAD_REQUEST). That
 * enforcement path reuses the PURE engine (effectiveMissingInfoFields +
 * computeMissingInfo) which is unit-covered by missing-info.test.ts; a full
 * application-fixture integration test of the live transition is a follow-up.
 * TENANT ISOLATION is enforced by the table's FORCE ROW LEVEL SECURITY +
 * tenant_isolation policy (the platform-wide discipline), verified at migration.
 *
 * Owns the field `notice_period`: captures its pre-test policy row in beforeAll
 * and RESTORES it in afterAll, so the t21 seed / demo config is never clobbered.
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

// The field this suite owns. Its pre-test state is captured + restored so a
// seeded/demo override on it is never lost.
const TEST_FIELD = "notice_period";

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
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

interface FieldEntry {
  fieldKey: string;
  label: string;
  dataSource: string;
  requiredness: "required" | "optional";
  blocksAdvanceStage: string | null;
  defaultRequiredness: "required" | "optional";
  defaultBlocksAdvanceStage: string | null;
  isConfigured: boolean;
}
interface GetOut {
  fields: FieldEntry[];
}
interface UpsertOut {
  field: FieldEntry;
}

let recruiterJwt: string;
let hrHeadJwt: string;
let adminJwt: string;
let tenantId: string;
// Pre-test snapshot of the owned field's DB row (null = no override existed).
let savedRow: {
  requiredness: string;
  blocks_advance_stage: string | null;
} | null = null;

describe("T2.1 / G05 required-candidate-field policy", () => {
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

    const [row] = await poolSql<{ requiredness: string; blocks_advance_stage: string | null }[]>`
      SELECT requiredness, blocks_advance_stage
      FROM public.candidate_field_policy
      WHERE tenant_id = ${tenantId} AND field_key = ${TEST_FIELD}
    `;
    savedRow = row ?? null;
  });

  afterAll(async () => {
    // Restore the owned field to exactly its pre-test state.
    await poolSql`
      DELETE FROM public.candidate_field_policy
      WHERE tenant_id = ${tenantId} AND field_key = ${TEST_FIELD}
    `;
    if (savedRow) {
      await poolSql`
        INSERT INTO public.candidate_field_policy (tenant_id, field_key, requiredness, blocks_advance_stage)
        VALUES (${tenantId}, ${TEST_FIELD}, ${savedRow.requiredness}, ${savedRow.blocks_advance_stage})
      `;
    }
  });

  it("Test 1: get returns the 7-field catalog; upsert saves an override; get reflects it; idempotent", async () => {
    const before = await trpcQuery<GetOut>("getCandidateFieldPolicy", {}, adminJwt);
    assert.ok(!isErr(before), `getCandidateFieldPolicy (admin): ${JSON.stringify(before)}`);
    assert.equal(before.result.data.fields.length, 7, "all 7 catalog fields present");
    const owned = before.result.data.fields.find((f) => f.fieldKey === TEST_FIELD);
    assert.ok(owned, `${TEST_FIELD} in catalog`);
    assert.ok(owned!.label.length > 0 && owned!.dataSource.length > 0, "catalog metadata present");

    // Override: make it optional + non-gating (a change from its 'required' default).
    const up = await trpcMutation<UpsertOut>(
      "upsertCandidateFieldPolicy",
      { fieldKey: TEST_FIELD, requiredness: "optional", blocksAdvanceStage: null },
      adminJwt,
    );
    assert.ok(!isErr(up), `upsert (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.field.requiredness, "optional");
    assert.equal(up.result.data.field.isConfigured, true, "saved row → isConfigured");

    const after = await trpcQuery<GetOut>("getCandidateFieldPolicy", {}, adminJwt);
    assert.ok(!isErr(after));
    const nowOwned = after.result.data.fields.find((f) => f.fieldKey === TEST_FIELD)!;
    assert.equal(nowOwned.requiredness, "optional", "override reflected in get");
    assert.equal(nowOwned.isConfigured, true);

    // Idempotent: a second upsert on the same (tenant, fieldKey) updates in place.
    const up2 = await trpcMutation<UpsertOut>(
      "upsertCandidateFieldPolicy",
      { fieldKey: TEST_FIELD, requiredness: "required", blocksAdvanceStage: null },
      adminJwt,
    );
    assert.ok(!isErr(up2), `upsert#2 (admin): ${JSON.stringify(up2)}`);
    assert.equal(up2.result.data.field.requiredness, "required", "in-place update");
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.candidate_field_policy
      WHERE tenant_id = ${tenantId} AND field_key = ${TEST_FIELD}
    `;
    assert.equal(n, 1, "still exactly one row for the field (upsert, not insert-twice)");
  });

  it("Test 2: reset removes the override → field falls back to the code default", async () => {
    const reset = await trpcMutation<UpsertOut>(
      "resetCandidateFieldPolicy",
      { fieldKey: TEST_FIELD },
      adminJwt,
    );
    assert.ok(!isErr(reset), `reset (admin): ${JSON.stringify(reset)}`);
    assert.equal(reset.result.data.field.isConfigured, false, "reset → back to code default");
    assert.equal(
      reset.result.data.field.requiredness,
      reset.result.data.field.defaultRequiredness,
      "effective == default after reset",
    );
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.candidate_field_policy
      WHERE tenant_id = ${tenantId} AND field_key = ${TEST_FIELD}
    `;
    assert.equal(n, 0, "policy row deleted on reset");
  });

  it("Test 3: read gating — getCandidateFieldPolicy is admin-only (recruiter + hr_head FORBIDDEN)", async () => {
    for (const [who, jwt] of [
      ["recruiter", recruiterJwt],
      ["hr_head", hrHeadJwt],
    ] as const) {
      const res = await trpcQuery<GetOut>("getCandidateFieldPolicy", {}, jwt);
      assert.ok(
        isErr(res) && res.error.data.code === "FORBIDDEN",
        `${who} FORBIDDEN on read: ${JSON.stringify(res)}`,
      );
    }
  });

  it("Test 4: write gating — recruiter FORBIDDEN on upsert AND reset", async () => {
    const up = await trpcMutation<UpsertOut>(
      "upsertCandidateFieldPolicy",
      { fieldKey: TEST_FIELD, requiredness: "optional", blocksAdvanceStage: null },
      recruiterJwt,
    );
    assert.ok(isErr(up) && up.error.data.code === "FORBIDDEN", "recruiter FORBIDDEN on upsert");
    const reset = await trpcMutation<UpsertOut>(
      "resetCandidateFieldPolicy",
      { fieldKey: TEST_FIELD },
      recruiterJwt,
    );
    assert.ok(
      isErr(reset) && reset.error.data.code === "FORBIDDEN",
      "recruiter FORBIDDEN on reset",
    );
  });

  it("Test 5: validation — unknown fieldKey and invalid stage are rejected", async () => {
    const badField = await trpcMutation(
      "upsertCandidateFieldPolicy",
      { fieldKey: "not_a_real_field", requiredness: "required", blocksAdvanceStage: null },
      adminJwt,
    );
    assert.ok(isErr(badField), "unknown fieldKey rejected");
    const badStage = await trpcMutation(
      "upsertCandidateFieldPolicy",
      { fieldKey: TEST_FIELD, requiredness: "required", blocksAdvanceStage: "not_a_stage" },
      adminJwt,
    );
    assert.ok(isErr(badStage), "invalid blocksAdvanceStage rejected");
  });
});
