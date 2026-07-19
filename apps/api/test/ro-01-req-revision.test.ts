/**
 * RO-01 — AI requisition-revision suggestions API suite.
 *
 * Exercised over real cloud-minted JWTs (reality #110 — the seeded personas)
 * against reqs driven through the real create → submit → reject machinery
 * (NODE_ENV=test → LocalAIClient fixtures, no tokens spent):
 *
 *   Test 1: rejected-only guard — generate on a NON-rejected (pending) req →
 *           BAD_REQUEST, and getReqRevisionSuggestions reports eligible=false.
 *   Test 2: only-owner-or-admin — recruiter FORBIDDEN; owner (hiring_manager)
 *           generates → one req_revision_suggestions row cached + a
 *           req_revision ai_usage_logs row; regenerate REPLACES (still one row);
 *           admin can also generate.
 *   Test 3: kill-switch — admin disables req_revision → generate BAD_REQUEST
 *           with a clean message and NO usage-log delta; settings restored.
 *
 * Requires `pnpm db:seed:test-users` (hiringmanager1 / hrhead1 / recruiter1 /
 * admin1). Cleans up its own rows in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
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
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const TITLE_REJECTED = `RO-01 Rejected Engineer ${RUN}`;
const DEPT_REJECTED = `RO-01 Platform ${RUN}`;
const TITLE_PENDING = `RO-01 Pending Analyst ${RUN}`;
const DEPT_PENDING = `RO-01 Analytics ${RUN}`;

let recruiterJwt: string;
let hiringManagerJwt: string;
let hrHeadJwt: string;
let adminJwt: string;
let tenantId: string;
let rejectedReq = "";
let pendingReq = "";
const writtenFixtures: string[] = [];

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
  const url =
    input === undefined
      ? `/trpc/${name}`
      : `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
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

/** Draft → JD sections + weighted skills (incl. a must-have) → pending. */
async function createPendingReq(title: string, department: string): Promise<string> {
  const create = await trpcMutation<{ requisitionId: string }>(
    "createRequisitionDraft",
    { title, department, locationType: "onsite", primaryLocation: "Bengaluru" },
    hiringManagerJwt,
  );
  assert.ok(!isErr(create), `createDraft: ${JSON.stringify(create)}`);
  const id = create.result.data.requisitionId;
  const upd = await trpcMutation(
    "updateRequisitionDraft",
    {
      requisitionId: id,
      sections: {
        summary: `Own the ${department} platform and its quality.`,
        responsibilities: ["Design systems.", "Ship reliably."],
        requirements: ["5+ years experience.", "Strong fundamentals."],
      },
      skills: [
        { skillName: "TypeScript", weight: 3, isRequired: true },
        { skillName: "Kubernetes", weight: 2, isRequired: false },
      ],
    },
    hiringManagerJwt,
  );
  assert.ok(!isErr(upd), `update: ${JSON.stringify(upd)}`);
  return id;
}

async function submitReq(id: string): Promise<string> {
  const submit = await trpcMutation<{ approvalRequestId: string }>(
    "submitRequisitionForApproval",
    { requisitionId: id },
    hiringManagerJwt,
  );
  assert.ok(!isErr(submit), `submit: ${JSON.stringify(submit)}`);
  return submit.result.data.approvalRequestId;
}

/** Generate suggestions; on a fixture miss, write a matching LocalAI fixture
 * keyed by the harvested prompt hash and retry (the hrhead-02/hrops-02 idiom). */
async function generateWithFixture(requisitionId: string, jwt: string) {
  const first = await trpcMutation<{ suggestions: { suggestions: unknown[] } }>(
    "generateReqRevisionSuggestions",
    { requisitionId },
    jwt,
  );
  if (!isErr(first)) return first;
  const match = /prompt hash ([a-f0-9]{64})/.exec(first.error.message ?? "");
  if (!match) return first; // a real error (e.g. FORBIDDEN / BAD_REQUEST) — let the caller assert
  const path = resolve(FIXTURE_DIR, `${match[1]!}.json`);
  writtenFixtures.push(path);
  await writeFile(
    path,
    JSON.stringify({
      json: {
        suggestions: [
          {
            area: "budget",
            title: "Raise the budget toward market median",
            detail:
              "The rejection cited an uncompetitive band; lift the ceiling closer to the benchmark median.",
          },
          {
            area: "skills",
            title: "Trim niche must-haves",
            detail: "Move Kubernetes to nice-to-have so the requirement list is more attainable.",
          },
          {
            area: "scope",
            title: "Clarify the role scope",
            detail:
              "Tighten the responsibilities so the seniority matches the budget on resubmission.",
          },
        ],
      },
      inputTokens: 480,
      outputTokens: 120,
      costMicros: 3900,
      latencyMs: 350,
    }),
  );
  return trpcMutation<{ suggestions: { suggestions: unknown[] } }>(
    "generateReqRevisionSuggestions",
    { requisitionId },
    jwt,
  );
}

async function cleanupReq(id: string): Promise<void> {
  if (!id) return;
  try {
    const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
      SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${id}
    `;
    await poolSql`DELETE FROM public.req_revision_suggestions WHERE tenant_id = ${tenantId} AND requisition_id = ${id}`;
    await poolSql`
      DELETE FROM public.approval_decisions d USING public.approval_requests r
      WHERE d.request_id = r.id AND r.tenant_id = ${tenantId} AND r.subject_id = ${id}
    `;
    await poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId} AND subject_id = ${id}`;
    await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${id}`;
    await poolSql`DELETE FROM public.requisitions WHERE id = ${id}`;
    if (row) {
      await poolSql`DELETE FROM public.jd_skills WHERE jd_version_id = ${row.jd_version_id}`;
      await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
      await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
    }
  } catch (err) {
    console.warn("RO-01 cleanup step failed (continuing):", err);
  }
}

describe("RO-01 req_revision suggestions", () => {
  beforeAll(async () => {
    [recruiterJwt, hiringManagerJwt, hrHeadJwt, adminJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
      signIn(HR_HEAD),
      signIn(ADMIN),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    // A rejected req: create → submit → HR-head rejects with a reason.
    rejectedReq = await createPendingReq(TITLE_REJECTED, DEPT_REJECTED);
    const rejectedApprovalId = await submitReq(rejectedReq);
    const reject = await trpcMutation(
      "decideRequisitionApproval",
      {
        approvalRequestId: rejectedApprovalId,
        decision: "reject",
        reason: "Budget is well below market for this role.",
      },
      hrHeadJwt,
    );
    assert.ok(!isErr(reject), `reject: ${JSON.stringify(reject)}`);

    // A pending (non-rejected) req for the rejected-only guard.
    pendingReq = await createPendingReq(TITLE_PENDING, DEPT_PENDING);
    await submitReq(pendingReq);
  });

  afterAll(async () => {
    await cleanupReq(rejectedReq);
    await cleanupReq(pendingReq);
    for (const p of writtenFixtures) await unlink(p).catch(() => {});
  });

  it("Test 1: rejected-only guard — pending req refuses + reports ineligible", async () => {
    const gen = await trpcMutation(
      "generateReqRevisionSuggestions",
      { requisitionId: pendingReq },
      hiringManagerJwt,
    );
    assert.ok(isErr(gen), "generate on a non-rejected req refuses");
    assert.equal(gen.error.data.code, "BAD_REQUEST");
    assert.ok(
      (gen.error.message ?? "").toLowerCase().includes("rejected"),
      `mentions rejected-only: ${gen.error.message}`,
    );

    const read = await trpcQuery<{ eligible: boolean; suggestions: unknown }>(
      "getReqRevisionSuggestions",
      { requisitionId: pendingReq },
      hiringManagerJwt,
    );
    assert.ok(!isErr(read), `read: ${JSON.stringify(read)}`);
    assert.equal(read.result.data.eligible, false, "pending req is not eligible");
    assert.equal(read.result.data.suggestions, null, "no suggestions cached");
  });

  it("Test 2: only-owner-or-admin + cache + regenerate replaces + cost-logged", async () => {
    // Recruiter is neither owner nor admin → FORBIDDEN (role gate).
    const denied = await trpcMutation(
      "generateReqRevisionSuggestions",
      { requisitionId: rejectedReq },
      recruiterJwt,
    );
    assert.ok(isErr(denied), "recruiter refused");
    assert.equal(denied.error.data.code, "FORBIDDEN");

    // Owner (hiring_manager) generates.
    const gen = await generateWithFixture(rejectedReq, hiringManagerJwt);
    assert.ok(!isErr(gen), `generate: ${JSON.stringify(gen)}`);
    assert.ok(gen.result.data.suggestions.suggestions.length >= 3, "3+ suggestions returned");

    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.req_revision_suggestions
      WHERE tenant_id = ${tenantId} AND requisition_id = ${rejectedReq}
    `;
    assert.equal(Number(n), 1, "one req_revision_suggestions row cached");

    const [{ un } = { un: 0 }] = await poolSql<{ un: number }[]>`
      SELECT count(*)::int AS un FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'req_revision' AND succeeded = true
    `;
    assert.ok(Number(un) >= 1, "a successful req_revision ai_usage_logs row exists");

    // Regenerate → REPLACES (still one row).
    const again = await generateWithFixture(rejectedReq, hiringManagerJwt);
    assert.ok(!isErr(again), `regenerate: ${JSON.stringify(again)}`);
    const [{ n2 } = { n2: 0 }] = await poolSql<{ n2: number }[]>`
      SELECT count(*)::int AS n2 FROM public.req_revision_suggestions
      WHERE tenant_id = ${tenantId} AND requisition_id = ${rejectedReq}
    `;
    assert.equal(Number(n2), 1, "regenerate replaced the cached row");

    // Admin can also generate (owner-or-admin: admin bypass).
    const asAdmin = await generateWithFixture(rejectedReq, adminJwt);
    assert.ok(!isErr(asAdmin), `admin generate: ${JSON.stringify(asAdmin)}`);

    // Readable, eligible, with cached suggestions.
    const read = await trpcQuery<{
      eligible: boolean;
      suggestions: { suggestions: unknown[] } | null;
    }>("getReqRevisionSuggestions", { requisitionId: rejectedReq }, hiringManagerJwt);
    assert.ok(!isErr(read), `read: ${JSON.stringify(read)}`);
    assert.equal(read.result.data.eligible, true, "rejected req is eligible");
    assert.ok(read.result.data.suggestions, "cached suggestions present");
  });

  it("Test 3: kill-switch — disabled feature refuses cleanly, no usage delta", async () => {
    interface Settings {
      [k: string]: unknown;
      req_revision: { enabled: boolean };
    }
    const current = await trpcQuery<Settings>("getTenantAiSettings", {}, adminJwt);
    assert.ok(!isErr(current), `getTenantAiSettings: ${JSON.stringify(current)}`);
    const original = current.result.data;

    const [{ before } = { before: 0 }] = await poolSql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM public.ai_usage_logs
      WHERE tenant_id = ${tenantId} AND feature = 'req_revision'
    `;

    const disabled = { ...original, req_revision: { ...original.req_revision, enabled: false } };
    const off = await trpcMutation("updateTenantAiSettings", disabled, adminJwt);
    assert.ok(!isErr(off), `disable: ${JSON.stringify(off)}`);

    try {
      const refused = await trpcMutation(
        "generateReqRevisionSuggestions",
        { requisitionId: rejectedReq },
        hiringManagerJwt,
      );
      assert.ok(isErr(refused), "disabled feature refuses");
      assert.equal(refused.error.data.code, "BAD_REQUEST");
      assert.ok(
        (refused.error.message ?? "").toLowerCase().includes("disabled"),
        `clean disabled message: ${refused.error.message}`,
      );
      const [{ after } = { after: 0 }] = await poolSql<{ after: number }[]>`
        SELECT count(*)::int AS after FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId} AND feature = 'req_revision'
      `;
      assert.equal(Number(after), Number(before), "no usage log written while disabled");

      // getReqRevisionSuggestions honestly reports the feature off.
      const read = await trpcQuery<{ featureEnabled: boolean }>(
        "getReqRevisionSuggestions",
        { requisitionId: rejectedReq },
        hiringManagerJwt,
      );
      assert.ok(!isErr(read), `read: ${JSON.stringify(read)}`);
      assert.equal(
        read.result.data.featureEnabled,
        false,
        "featureEnabled reflects the kill-switch",
      );
    } finally {
      const restore = await trpcMutation("updateTenantAiSettings", original, adminJwt);
      assert.ok(!isErr(restore), `restore settings: ${JSON.stringify(restore)}`);
    }
  });
});
