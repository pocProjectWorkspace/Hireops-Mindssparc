/**
 * T-POLICY — per-role Iris action policy (DENY-OVERLAY) end-to-end flip test.
 *
 * Proves the policy is BOTH persisted AND enforced at the Iris call sites, over
 * real cloud-minted JWTs (the seeded personas), on the shared kyndryl-poc tenant:
 *
 *   Test 1 (UNCONFIGURED = today): with no stored irisPolicy, recruiter1's
 *     irisListActions carries the full recruiter set — reject_application is
 *     present (byte-identical to before this feature existed).
 *
 *   Test 2 (PERSISTED + ENFORCED): admin1 writes a policy via updateIrisPolicy
 *     disabling reject_application for recruiter. The block is really persisted
 *     under tenants.settings.irisPolicy, and the deny-overlay is enforced at all
 *     the recruiter's Iris call sites: irisListActions OMITS reject_application,
 *     and irisPreview / irisExecute of it throw FORBIDDEN. admin (a super-role
 *     NOT in the deny list) is unaffected — it still sees + can preview it,
 *     proving the overlay narrows PER ROLE, never globally.
 *
 *   Test 3 (FLIP BACK): clearing the overlay restores the full recruiter set —
 *     reject_application is available to recruiter1 again.
 *
 * The role gate fires BEFORE param validation / any entity lookup, so the
 * FORBIDDEN assertions need only a dummy application id — no FK seeding. The
 * test captures + restores the tenant's original irisPolicy so it is inert for
 * every other suite.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1).
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
const TENANT_SLUG = "kyndryl-poc";

let adminJwt: string;
let recruiterJwt: string;
let tenantId: string;
// The tenant's irisPolicy value BEFORE this suite ran, restored in afterAll so
// no other suite ever sees this test's overlay.
let originalPolicyJson: string | null = null;

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

/** Overwrite (or clear) the tenant's irisPolicy sibling key directly. */
async function setStoredPolicy(json: string | null): Promise<void> {
  if (json === null) {
    await poolSql`
      UPDATE public.tenants SET settings = COALESCE(settings, '{}'::jsonb) - 'irisPolicy'
      WHERE id = ${tenantId}
    `;
  } else {
    await poolSql`
      UPDATE public.tenants
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('irisPolicy', ${json}::jsonb)
      WHERE id = ${tenantId}
    `;
  }
}

describe("T-POLICY per-role Iris action policy flip (persisted + enforced)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    const [t] = await poolSql<{ id: string; iris_policy: unknown }[]>`
      SELECT id, settings->'irisPolicy' AS iris_policy
      FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalPolicyJson = t.iris_policy == null ? null : JSON.stringify(t.iris_policy);
    // Start from a known-unconfigured baseline.
    await setStoredPolicy(null);
  });

  afterAll(async () => {
    try {
      await setStoredPolicy(originalPolicyJson);
    } catch {
      // best-effort restore.
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1 (UNCONFIGURED = today): recruiter's menu carries the full set incl. reject_application", async () => {
    const list = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      recruiterJwt,
    );
    assert.ok(!isErr(list), `recruiter can list, got ${JSON.stringify(list)}`);
    const ids = new Set(list.result.data.actions.map((a) => a.id));
    assert.ok(ids.has("reject_application"), "unconfigured: recruiter menu HAS reject_application");
    assert.ok(
      ids.has("advance_application"),
      "unconfigured: recruiter menu HAS advance_application",
    );
  });

  it("Test 2 (PERSISTED + ENFORCED): disabling reject_application for recruiter removes it from the menu + FORBIDs preview/execute; admin unaffected", async () => {
    // Persist via the REAL admin write proc (proves the write path).
    const saved = await trpcMutation<{ policy: { disabledRoles: Record<string, string[]> } }>(
      "updateIrisPolicy",
      { policy: { disabledRoles: { reject_application: ["recruiter"] } } },
      adminJwt,
    );
    assert.ok(!isErr(saved), `admin can save policy, got ${JSON.stringify(saved)}`);
    assert.deepEqual(
      saved.result.data.policy.disabledRoles.reject_application,
      ["recruiter"],
      "write proc echoes the overlay",
    );

    // It really landed under tenants.settings.irisPolicy (persisted).
    const [row] = await poolSql<{ disabled: unknown }[]>`
      SELECT settings->'irisPolicy'->'disabledRoles' AS disabled
      FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.deepEqual(
      (row?.disabled as Record<string, string[]>)?.reject_application,
      ["recruiter"],
      "overlay is persisted in tenants.settings.irisPolicy",
    );

    // ENFORCED at irisListActions: recruiter's menu drops reject_application but
    // keeps its other pipeline actions (only that one role/action was narrowed).
    const list = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      recruiterJwt,
    );
    assert.ok(!isErr(list), `recruiter can list, got ${JSON.stringify(list)}`);
    const ids = new Set(list.result.data.actions.map((a) => a.id));
    assert.ok(!ids.has("reject_application"), "ENFORCED: recruiter menu OMITS reject_application");
    assert.ok(ids.has("advance_application"), "recruiter keeps advance_application (not narrowed)");

    // ENFORCED at irisPreview: FORBIDDEN before any param validation / lookup.
    const preview = await trpcQuery(
      "irisPreview",
      { actionId: "reject_application", params: { applicationId: randomUUID(), reason: "x" } },
      recruiterJwt,
    );
    assert.ok(
      isErr(preview) && preview.error.data.code === "FORBIDDEN",
      `recruiter reject preview FORBIDDEN, got ${JSON.stringify(preview)}`,
    );

    // ENFORCED at irisExecute: FORBIDDEN before dispatch/commit.
    const exec = await trpcMutation(
      "irisExecute",
      { actionId: "reject_application", params: { applicationId: randomUUID(), reason: "x" } },
      recruiterJwt,
    );
    assert.ok(
      isErr(exec) && exec.error.data.code === "FORBIDDEN",
      `recruiter reject execute FORBIDDEN, got ${JSON.stringify(exec)}`,
    );

    // admin (super-role, NOT in the deny list) is UNAFFECTED — narrowing is per
    // role, never global. Its menu still carries reject_application.
    const adminList = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      adminJwt,
    );
    assert.ok(!isErr(adminList), `admin can list, got ${JSON.stringify(adminList)}`);
    assert.ok(
      new Set(adminList.result.data.actions.map((a) => a.id)).has("reject_application"),
      "admin still sees reject_application (per-role narrowing, admin not disabled)",
    );
  });

  it("Test 3 (FLIP BACK): clearing the overlay restores reject_application for recruiter", async () => {
    const saved = await trpcMutation<{ policy: { disabledRoles: Record<string, string[]> } }>(
      "updateIrisPolicy",
      { policy: { disabledRoles: {} } },
      adminJwt,
    );
    assert.ok(!isErr(saved), `admin can clear policy, got ${JSON.stringify(saved)}`);

    const list = await trpcQuery<{ actions: { id: string }[] }>(
      "irisListActions",
      {},
      recruiterJwt,
    );
    assert.ok(!isErr(list), `recruiter can list, got ${JSON.stringify(list)}`);
    assert.ok(
      new Set(list.result.data.actions.map((a) => a.id)).has("reject_application"),
      "cleared: recruiter menu HAS reject_application again",
    );
  });
});
