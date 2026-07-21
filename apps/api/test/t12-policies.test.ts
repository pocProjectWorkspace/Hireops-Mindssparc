/**
 * T12 / G10 — HR policy library: org-editable versioning + soft archive.
 *
 * Makes real the create / edit / version / archive lifecycle the HR-policy
 * surface now offers on top of the seeded READ-ONLY reference library. Exercised
 * over real cloud-minted JWTs (reality #110 — the seeded personas), NODE_ENV=test
 * (no AI tokens spent — policy content is plain Markdown the caller supplies).
 *
 *   Test 1: createHrPolicy → returns the doc at version 1 AND writes a matching
 *           v1 snapshot into hr_policy_document_versions.
 *   Test 2: updateHrPolicy on a policy that already HAS history → version bumps
 *           to 2 + a v2 snapshot appended (no double-backfill).
 *   Test 3: updateHrPolicy on a seeded-style policy with NO history → backfills
 *           the current content as v1 THEN writes v2 (two snapshot rows appear).
 *   Test 4: listHrPolicyVersions returns the history newest-first.
 *   Test 5: archiveHrPolicy hides the policy from the default list; passing
 *           includeArchived surfaces it again.
 *   Test 6: role gate — hr_ops + admin pass; recruiter / hiring_manager / hr_head
 *           are FORBIDDEN on both the read list and the write mutations.
 *   Test 7: RLS — the policy + its versions are invisible under another tenant's
 *           context.
 *
 * Requires db:seed:test-users (recruiter1 / hr_ops1 / admin1 / hiringmanager1 /
 * hrhead1). Cleans up ALL rows it creates in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  withTenantContext,
  hrPolicyDocuments,
  hrPolicyDocumentVersions,
  type JwtClaims,
} from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE_A = `T12 Remote Work Policy ${RUN}`;
const TITLE_B_SEEDED = `T12 Seeded-Style Leave Policy ${RUN}`;
// Fixed UUID for the directly-inserted (seeded-style, history-less) policy B.
const POLICY_B_ID = "00000000-0000-4000-8000-000000b12001";
const SYNTH_TENANT = "00000000-0000-4000-8000-000000b12f01";

let adminJwt: string;
let hrOpsJwt: string;
let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;
let adminClaims: JwtClaims;
let tenantId: string;

let policyAId = "";

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
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
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

interface PolicyRow {
  id: string;
  title: string;
  category: string;
  summary: string;
  bodyMd: string;
  version: number;
  isArchived: boolean;
  updatedAt: string;
}
interface VersionRow {
  id: string;
  policyDocumentId: string;
  version: number;
  title: string;
  bodyMd: string;
  changeNote: string | null;
  createdAt: string;
}

async function cleanup(): Promise<void> {
  // versions cascade off the doc, but delete explicitly to be safe + cheap.
  for (const id of [policyAId, POLICY_B_ID]) {
    if (!id) continue;
    await poolSql`DELETE FROM public.hr_policy_document_versions WHERE policy_document_id = ${id}`;
    await poolSql`DELETE FROM public.hr_policy_documents WHERE id = ${id}`;
  }
  // Belt-and-braces: sweep any residue by the run-scoped titles.
  await poolSql`
    DELETE FROM public.hr_policy_documents
    WHERE tenant_id = ${tenantId} AND title IN (${TITLE_A}, ${TITLE_B_SEEDED})
  `;
}

describe("T12/G10 HR policy versioning + archive", () => {
  beforeAll(async () => {
    [adminJwt, hrOpsJwt, recruiterJwt, hiringManagerJwt, hrHeadJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(HR_OPS),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
    ]);
    adminClaims = decodeJwt(adminJwt) as JwtClaims;
    tenantId = adminClaims.tid as string;
    if (!tenantId) throw new Error("admin JWT missing tid");

    await cleanup();

    // Policy B: a seeded-style doc inserted DIRECTLY (version 1, no history rows)
    // to exercise the first-edit backfill path in updateHrPolicy.
    await poolSql`
      INSERT INTO public.hr_policy_documents
        (id, tenant_id, title, category, summary, body_md, version, is_archived)
      VALUES
        (${POLICY_B_ID}, ${tenantId}, ${TITLE_B_SEEDED}, 'policies',
         'Original seeded summary.', '## Leave\nOriginal seeded body.', 1, false)
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: createHrPolicy lands at version 1 + writes a v1 snapshot", async () => {
    const res = await trpcMutation<{ row: PolicyRow }>(
      "createHrPolicy",
      {
        title: TITLE_A,
        category: "policies",
        summary: "How and when employees may work remotely.",
        bodyMd: "## Remote work\nEligible roles may work remotely up to 3 days a week.",
        changeNote: "Initial version.",
      },
      hrOpsJwt,
    );
    assert.ok(!isErr(res), `create: ${JSON.stringify(res)}`);
    policyAId = res.result.data.row.id;
    assert.equal(res.result.data.row.version, 1, "new policy starts at version 1");
    assert.equal(res.result.data.row.isArchived, false);

    const versions = await poolSql<{ version: number; change_note: string | null }[]>`
      SELECT version, change_note FROM public.hr_policy_document_versions
      WHERE policy_document_id = ${policyAId} ORDER BY version
    `;
    assert.equal(versions.length, 1, "exactly one snapshot on create");
    assert.equal(Number(versions[0]!.version), 1, "the snapshot is v1");
    assert.equal(versions[0]!.change_note, "Initial version.", "change note captured on v1");
  });

  it("Test 2: updateHrPolicy on a policy with history → v2, no double-backfill", async () => {
    const res = await trpcMutation<{ row: PolicyRow }>(
      "updateHrPolicy",
      {
        id: policyAId,
        title: TITLE_A,
        category: "policies",
        summary: "How and when employees may work remotely (revised).",
        bodyMd: "## Remote work\nEligible roles may work remotely up to 4 days a week.",
        changeNote: "Raised the remote-day allowance.",
      },
      hrOpsJwt,
    );
    assert.ok(!isErr(res), `update: ${JSON.stringify(res)}`);
    assert.equal(res.result.data.row.version, 2, "version bumped to 2");

    const versions = await poolSql<{ version: number }[]>`
      SELECT version FROM public.hr_policy_document_versions
      WHERE policy_document_id = ${policyAId} ORDER BY version
    `;
    assert.deepEqual(
      versions.map((v) => Number(v.version)),
      [1, 2],
      "history has exactly v1 + v2 (create wrote v1, so no backfill)",
    );
  });

  it("Test 3: updateHrPolicy on a history-less doc backfills v1 THEN writes v2", async () => {
    const before = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.hr_policy_document_versions
      WHERE policy_document_id = ${POLICY_B_ID}
    `;
    assert.equal(Number(before[0]?.n), 0, "seeded-style doc starts with no history");

    const res = await trpcMutation<{ row: PolicyRow }>(
      "updateHrPolicy",
      {
        id: POLICY_B_ID,
        title: TITLE_B_SEEDED,
        category: "policies",
        summary: "Revised leave summary.",
        bodyMd: "## Leave\nRevised leave body.",
        changeNote: "First real edit of a seeded policy.",
      },
      adminJwt,
    );
    assert.ok(!isErr(res), `update B: ${JSON.stringify(res)}`);
    assert.equal(res.result.data.row.version, 2, "version bumped to 2");

    const versions = await poolSql<
      { version: number; body_md: string; change_note: string | null }[]
    >`
      SELECT version, body_md, change_note FROM public.hr_policy_document_versions
      WHERE policy_document_id = ${POLICY_B_ID} ORDER BY version
    `;
    assert.equal(versions.length, 2, "backfill produced v1 + v2 (two rows)");
    assert.equal(Number(versions[0]!.version), 1, "v1 backfilled");
    assert.equal(
      versions[0]!.body_md,
      "## Leave\nOriginal seeded body.",
      "v1 snapshot preserves the ORIGINAL content",
    );
    assert.equal(Number(versions[1]!.version), 2, "v2 is the edit");
    assert.equal(versions[1]!.body_md, "## Leave\nRevised leave body.");
  });

  it("Test 4: listHrPolicyVersions returns history newest-first", async () => {
    const res = await trpcQuery<{ items: VersionRow[] }>(
      "listHrPolicyVersions",
      { policyId: policyAId },
      hrOpsJwt,
    );
    assert.ok(!isErr(res), `versions: ${JSON.stringify(res)}`);
    const versions = res.result.data.items.map((v) => v.version);
    assert.deepEqual(versions, [2, 1], "newest version first");
    assert.equal(res.result.data.items[0]!.changeNote, "Raised the remote-day allowance.");
  });

  it("Test 5: archiveHrPolicy hides from default list; includeArchived surfaces it", async () => {
    const arch = await trpcMutation<{ row: PolicyRow }>(
      "archiveHrPolicy",
      { id: policyAId, isArchived: true },
      hrOpsJwt,
    );
    assert.ok(!isErr(arch), `archive: ${JSON.stringify(arch)}`);
    assert.equal(arch.result.data.row.isArchived, true);

    const def = await trpcQuery<{ items: PolicyRow[] }>("listHrPolicies", {}, hrOpsJwt);
    assert.ok(!isErr(def), `default list: ${JSON.stringify(def)}`);
    assert.ok(
      !def.result.data.items.some((p) => p.id === policyAId),
      "archived policy hidden from the default list",
    );

    const inc = await trpcQuery<{ items: PolicyRow[] }>(
      "listHrPolicies",
      { includeArchived: true },
      hrOpsJwt,
    );
    assert.ok(!isErr(inc), `includeArchived list: ${JSON.stringify(inc)}`);
    const found = inc.result.data.items.find((p) => p.id === policyAId);
    assert.ok(found, "includeArchived surfaces the archived policy");
    assert.equal(found!.isArchived, true);

    // Restore so the row is back in the default view (and version 2 intact).
    const restore = await trpcMutation<{ row: PolicyRow }>(
      "archiveHrPolicy",
      { id: policyAId, isArchived: false },
      hrOpsJwt,
    );
    assert.ok(!isErr(restore) && restore.result.data.row.isArchived === false, "restore works");
  });

  it("Test 6: role gate — hr_ops/admin pass; recruiter/HM/hr_head FORBIDDEN", async () => {
    // Admin (the other allowed role) can read.
    const adminList = await trpcQuery<{ items: PolicyRow[] }>("listHrPolicies", {}, adminJwt);
    assert.ok(!isErr(adminList), "admin can read policies");

    for (const [label, jwt] of [
      ["recruiter", recruiterJwt],
      ["hiring_manager", hiringManagerJwt],
      ["hr_head", hrHeadJwt],
    ] as const) {
      const list = await trpcQuery("listHrPolicies", {}, jwt);
      assert.ok(isErr(list) && list.error.data.code === "FORBIDDEN", `${label} read forbidden`);
      const create = await trpcMutation(
        "createHrPolicy",
        { title: `nope ${label}`, category: "policies", summary: "x", bodyMd: "y" },
        jwt,
      );
      assert.ok(
        isErr(create) && create.error.data.code === "FORBIDDEN",
        `${label} create forbidden`,
      );
      const update = await trpcMutation(
        "updateHrPolicy",
        { id: policyAId, title: TITLE_A, category: "policies", summary: "x", bodyMd: "y" },
        jwt,
      );
      assert.ok(
        isErr(update) && update.error.data.code === "FORBIDDEN",
        `${label} update forbidden`,
      );
    }
  });

  it("Test 7: RLS — policy + versions invisible from another tenant's context", async () => {
    const ownDoc = await withTenantContext(adminClaims, async ({ db }) =>
      db
        .select({ id: hrPolicyDocuments.id })
        .from(hrPolicyDocuments)
        .where(eq(hrPolicyDocuments.id, policyAId)),
    );
    assert.equal(ownDoc.length, 1, "owning tenant sees the policy");

    const synthClaims: JwtClaims = {
      sub: "00000000-0000-4000-8000-000000b12faa",
      tid: SYNTH_TENANT,
      roles: ["hr_ops"],
    };
    const crossDoc = await withTenantContext(synthClaims, async ({ db }) =>
      db
        .select({ id: hrPolicyDocuments.id })
        .from(hrPolicyDocuments)
        .where(eq(hrPolicyDocuments.id, policyAId)),
    );
    assert.equal(crossDoc.length, 0, "cross-tenant context sees no policy");

    const crossVersions = await withTenantContext(synthClaims, async ({ db }) =>
      db
        .select({ id: hrPolicyDocumentVersions.id })
        .from(hrPolicyDocumentVersions)
        .where(eq(hrPolicyDocumentVersions.policyDocumentId, policyAId)),
    );
    assert.equal(crossVersions.length, 0, "cross-tenant context sees no version history");
  });
});
