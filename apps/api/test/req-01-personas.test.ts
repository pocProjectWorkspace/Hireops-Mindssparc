/**
 * REQ-01 (Wave A) — persona role-gating on the new requisition reads.
 *
 * Verifies the two skeleton reads enforce their persona gates end-to-end
 * through real cloud-minted JWTs (reality #110 — there is no local JWT
 * minting; we sign in as the seeded personas whose kyndryl-poc memberships
 * carry the exact roles under test):
 *
 *   - listRequisitionSummaries: hiring_manager ✓, recruiter ✓
 *   - listRequisitionApprovals: hr_head ✓, recruiter ✗ (FORBIDDEN)
 *   - tenant_role enum carries 'hr_head' (migration 0050 applied)
 *
 * Requires the seed to have run (`pnpm db:seed:test-users`) so
 * hiringmanager1@ / hrhead1@ exist in cloud auth with the right roles.
 * recruiter1@ has existed since the original test-user seed. Asserts on
 * success/FORBIDDEN shape, not row counts, so it's robust to demo-data
 * churn on the shared dev/staging DB.
 */

import "../src/bootstrap";

import { beforeAll, describe, it } from "vitest";
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
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";

let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;

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

async function trpcQuery<O>(
  name: string,
  input: unknown,
  jwt: string,
): Promise<TRPCSuccess<O> | TRPCErr> {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

describe("REQ-01 persona role-gating", () => {
  beforeAll(async () => {
    [recruiterJwt, hiringManagerJwt, hrHeadJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
    ]);
  });

  it("Test 1: tenant_role enum carries 'hr_head' (migration 0050)", async () => {
    const rows = await poolSql<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::tenant_role))::text AS v
    `;
    const values = rows.map((r) => r.v);
    assert.ok(
      values.includes("hr_head"),
      `expected 'hr_head' in tenant_role, got: ${values.join(",")}`,
    );
  });

  it("Test 2: hiring_manager may read listRequisitionSummaries", async () => {
    const res = await trpcQuery<{ rows: unknown[] }>(
      "listRequisitionSummaries",
      { limit: 50 },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.result.data.rows), "rows should be an array");
  });

  it("Test 3: recruiter may read listRequisitionSummaries", async () => {
    const res = await trpcQuery<{ rows: unknown[] }>(
      "listRequisitionSummaries",
      { limit: 50 },
      recruiterJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.result.data.rows), "rows should be an array");
  });

  it("Test 4: recruiter is FORBIDDEN from listRequisitionApprovals", async () => {
    const res = await trpcQuery<{ rows: unknown[] }>(
      "listRequisitionApprovals",
      { limit: 50 },
      recruiterJwt,
    );
    assert.ok(isErr(res), `expected FORBIDDEN, got ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "FORBIDDEN");
  });

  it("Test 5: hr_head may read listRequisitionApprovals", async () => {
    const res = await trpcQuery<{ rows: unknown[] }>(
      "listRequisitionApprovals",
      { limit: 50 },
      hrHeadJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.result.data.rows), "rows should be an array");
  });
});
