/**
 * T12 / G11 — JD-template library CRUD.
 *
 * The org's curated JD-template library (jd_templates) on /jd-library →
 * Templates. The requisition wizard's Quick-start row reads its presets from
 * listJdTemplates (falling back to the ROLE_TEMPLATES constant when the table is
 * empty). Exercised over real cloud-minted JWTs (reality #110), NODE_ENV=test.
 *
 *   Test 1: createJdTemplate → returns the row (archived=false, skills round-trip)
 *           and listJdTemplates surfaces it — the exact query the wizard runs
 *           (the "wizard reads the DB" path).
 *   Test 2: updateJdTemplate edits fields (budget, skills, seniority).
 *   Test 3: archiveJdTemplate hides it from the default list; includeArchived
 *           surfaces it again.
 *   Test 4: role gate — admin + hiring_manager pass; recruiter / hr_ops / hr_head
 *           are FORBIDDEN on both read and write.
 *   Test 5: RLS — the template is invisible from another tenant's context.
 *
 * Requires db:seed:test-users (admin1 / hiringmanager1 / recruiter1 / hr_ops1 /
 * hrhead1). Cleans up ALL rows it creates (+ the jd_templates audit_logs rows the
 * table's trigger emits) in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { app } from "../src/index.js";
import { sql as poolSql, withTenantContext, jdTemplates, type JwtClaims } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";

const RUN = Date.now().toString(36);
const TITLE = `T12 Staff ML Engineer ${RUN}`;
const SYNTH_TENANT = "00000000-0000-4000-8000-000000c12f01";

let adminJwt: string;
let hiringManagerJwt: string;
let recruiterJwt: string;
let hrOpsJwt: string;
let hrHeadJwt: string;
let adminClaims: JwtClaims;
let tenantId: string;

let templateId = "";

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

interface TemplateSkill {
  skillName: string;
  category: string;
  weight: number;
  isRequired: boolean;
  minYears: number | null;
}
interface TemplateRow {
  id: string;
  label: string;
  title: string;
  roleFamily: string;
  seniority: string;
  locationType: string;
  budgetMinInr: number;
  budgetMaxInr: number;
  extraContext: string;
  bodyMd: string;
  legalClauses: string;
  skills: TemplateSkill[];
  isArchived: boolean;
  sortOrder: number;
  updatedAt: string;
}

const BASE_INPUT = {
  label: "Staff ML Engineer",
  title: TITLE,
  roleFamily: "Engineering",
  seniority: "Staff",
  locationType: "hybrid" as const,
  budgetMinInr: 4000000,
  budgetMaxInr: 6000000,
  extraContext: "Applied ML platform team.",
  bodyMd: "## About the role\nOwn ML systems end-to-end.",
  legalClauses: "Equal-opportunity employer. Curated starting text — not legally reviewed.",
  skills: [
    { skillName: "Python", category: "Languages", weight: 9, isRequired: true, minYears: 6 },
    { skillName: "PyTorch", category: "Frameworks", weight: 8, isRequired: true, minYears: 4 },
  ],
  sortOrder: 100,
};

async function cleanup(): Promise<void> {
  if (templateId) {
    // Clear the audit_logs rows the jd_templates trigger emitted for this row.
    await poolSql`
      DELETE FROM public.audit_logs
      WHERE entity_type = 'jd_templates' AND entity_id = ${templateId}
    `;
    await poolSql`DELETE FROM public.jd_templates WHERE id = ${templateId}`;
  }
  await poolSql`DELETE FROM public.jd_templates WHERE tenant_id = ${tenantId} AND title = ${TITLE}`;
}

describe("T12/G11 JD-template library CRUD", () => {
  beforeAll(async () => {
    [adminJwt, hiringManagerJwt, recruiterJwt, hrOpsJwt, hrHeadJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(HIRING_MANAGER),
      signIn(RECRUITER),
      signIn(HR_OPS),
      signIn(HR_HEAD),
    ]);
    adminClaims = decodeJwt(adminJwt) as JwtClaims;
    tenantId = adminClaims.tid as string;
    if (!tenantId) throw new Error("admin JWT missing tid");
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: createJdTemplate → row, and listJdTemplates (wizard path) surfaces it", async () => {
    const create = await trpcMutation<{ row: TemplateRow }>(
      "createJdTemplate",
      BASE_INPUT,
      hiringManagerJwt,
    );
    assert.ok(!isErr(create), `create: ${JSON.stringify(create)}`);
    templateId = create.result.data.row.id;
    assert.equal(create.result.data.row.isArchived, false);
    assert.equal(create.result.data.row.budgetMinInr, 4000000, "budget in major INR units");
    assert.equal(create.result.data.row.skills.length, 2, "skills round-trip");
    assert.equal(create.result.data.row.skills[0]!.skillName, "Python");
    assert.equal(create.result.data.row.skills[0]!.minYears, 6);

    // This IS the query the requisition wizard runs to read DB presets.
    const list = await trpcQuery<{ items: TemplateRow[] }>("listJdTemplates", {}, hiringManagerJwt);
    assert.ok(!isErr(list), `list: ${JSON.stringify(list)}`);
    const mine = list.result.data.items.find((t) => t.id === templateId);
    assert.ok(mine, "the created template appears in the wizard-read list");
    assert.equal(mine!.title, TITLE);
    assert.equal(mine!.skills.length, 2, "skills survive the wire round-trip");
  });

  it("Test 2: updateJdTemplate edits fields", async () => {
    const upd = await trpcMutation<{ row: TemplateRow }>(
      "updateJdTemplate",
      {
        id: templateId,
        ...BASE_INPUT,
        seniority: "Principal",
        budgetMinInr: 5000000,
        budgetMaxInr: 7500000,
        skills: [
          ...BASE_INPUT.skills,
          {
            skillName: "MLOps",
            category: "Infrastructure",
            weight: 6,
            isRequired: false,
            minYears: 3,
          },
        ],
      },
      adminJwt,
    );
    assert.ok(!isErr(upd), `update: ${JSON.stringify(upd)}`);
    assert.equal(upd.result.data.row.seniority, "Principal");
    assert.equal(upd.result.data.row.budgetMinInr, 5000000);
    assert.equal(upd.result.data.row.skills.length, 3, "added skill persisted");
  });

  it("Test 3: archiveJdTemplate hides from default list; includeArchived surfaces it", async () => {
    const arch = await trpcMutation<{ row: TemplateRow }>(
      "archiveJdTemplate",
      { id: templateId, isArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(arch), `archive: ${JSON.stringify(arch)}`);
    assert.equal(arch.result.data.row.isArchived, true);

    const def = await trpcQuery<{ items: TemplateRow[] }>("listJdTemplates", {}, adminJwt);
    assert.ok(!isErr(def), `default list: ${JSON.stringify(def)}`);
    assert.ok(
      !def.result.data.items.some((t) => t.id === templateId),
      "archived template hidden from the default list",
    );

    const inc = await trpcQuery<{ items: TemplateRow[] }>(
      "listJdTemplates",
      { includeArchived: true },
      adminJwt,
    );
    assert.ok(!isErr(inc), `includeArchived list: ${JSON.stringify(inc)}`);
    assert.ok(
      inc.result.data.items.some((t) => t.id === templateId && t.isArchived),
      "includeArchived surfaces the archived template",
    );

    // Restore so the default wizard path stays clean until cleanup.
    const restore = await trpcMutation<{ row: TemplateRow }>(
      "archiveJdTemplate",
      { id: templateId, isArchived: false },
      adminJwt,
    );
    assert.ok(!isErr(restore) && restore.result.data.row.isArchived === false, "restore works");
  });

  it("Test 4: role gate — admin/hiring_manager pass; recruiter/hr_ops/hr_head FORBIDDEN", async () => {
    // Admin (already exercised via mutations) can also read.
    const adminList = await trpcQuery("listJdTemplates", {}, adminJwt);
    assert.ok(!isErr(adminList), "admin can read templates");

    for (const [label, jwt] of [
      ["recruiter", recruiterJwt],
      ["hr_ops", hrOpsJwt],
      ["hr_head", hrHeadJwt],
    ] as const) {
      const list = await trpcQuery("listJdTemplates", {}, jwt);
      assert.ok(isErr(list) && list.error.data.code === "FORBIDDEN", `${label} read forbidden`);
      const create = await trpcMutation("createJdTemplate", BASE_INPUT, jwt);
      assert.ok(
        isErr(create) && create.error.data.code === "FORBIDDEN",
        `${label} create forbidden`,
      );
      const archive = await trpcMutation(
        "archiveJdTemplate",
        { id: templateId, isArchived: true },
        jwt,
      );
      assert.ok(
        isErr(archive) && archive.error.data.code === "FORBIDDEN",
        `${label} archive forbidden`,
      );
    }
  });

  it("Test 5: RLS — the template is invisible from another tenant's context", async () => {
    const own = await withTenantContext(adminClaims, async ({ db }) =>
      db.select({ id: jdTemplates.id }).from(jdTemplates).where(eq(jdTemplates.id, templateId)),
    );
    assert.equal(own.length, 1, "owning tenant sees the template");

    const synthClaims: JwtClaims = {
      sub: "00000000-0000-4000-8000-000000c12faa",
      tid: SYNTH_TENANT,
      roles: ["hiring_manager"],
    };
    const cross = await withTenantContext(synthClaims, async ({ db }) =>
      db.select({ id: jdTemplates.id }).from(jdTemplates).where(eq(jdTemplates.id, templateId)),
    );
    assert.equal(cross.length, 0, "cross-tenant context sees no template");
  });
});
