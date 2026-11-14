/**
 * C2-F12 — applicability resolver: template assignments, named interview
 * loops, loop + scorecard resolution on plan seeding, the resolved-config
 * preview, config export/import, role gates (migration 0136).
 *
 * LOCAL POSTGRES ONLY (skipped otherwise — the default in CI and on the shared
 * DB). On an EMPTY database it creates minimal Supabase stubs and applies the
 * whole migration chain in journal order; on a database that already has the
 * chain up to 0135 it applies only 0136.
 *
 *   initdb -D /tmp/pg -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-p 55536" start
 *   createdb -h localhost -p 55536 -U postgres hireops_f12
 *   HIREOPS_LOCAL_PG_URL=postgres://postgres@localhost:55536/hireops_f12 \
 *     NODE_ENV=test DB_POOL_MAX=3 npx vitest run test/c2-f12-applicability.test.ts
 *
 * Coverage:
 *   - role gates (admin write; hr_head read + preview; others forbidden)
 *   - fallback with no assignments (default loop, pinned / 'general' scorecard)
 *   - write validation (unconsumed kind, foreign target, foreign condition id,
 *     duplicate name)
 *   - resolve for requisitions with entity / BU (descendant) / level attrs
 *   - loop resolution on plan seeding; scorecard fills only unpinned rounds
 *   - what-if preview by attributes
 *   - a scorecard referenced by an assignment can't be deleted
 *   - export → import round trip into another tenant
 *   - tenant isolation of assignments
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAS_LOCAL_PG, LOCAL_PG_URL, loadLocalDb } from "./local-pg-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "../../../packages/db/drizzle/migrations");

const id = (n: number) => `00000000-0000-4000-8000-0000c2f12${n.toString(16).padStart(3, "0")}`;
const T = id(0x001);
const T2 = id(0x002);
const U = id(0x003);
const M = id(0x004);
const M2 = id(0x005);
const E_IN = id(0x010);
const E_US = id(0x011);
const BU_FIN = id(0x020);
const BU_AP = id(0x021);
const BU_HR = id(0x022);
const BU_FOREIGN = id(0x023);
const LOC_HYD = id(0x030);
const FN_R2R = id(0x040);
const LV12 = id(0x050);
const LV15 = id(0x051);
const P_AP = id(0x060);
const P_HR = id(0x061);
const JD_AP = id(0x070);
const JD_HR = id(0x071);
const R_AP15 = id(0x080);
const R_HR12 = id(0x081);

const SUPABASE_STUBS = `
SET client_min_messages = warning;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role, supabase_auth_admin;
GRANT SELECT ON auth.users TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated, anon, service_role, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, service_role, supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon, supabase_auth_admin;
`;

type DbModule = Awaited<ReturnType<typeof loadLocalDb>>;
type Sql = DbModule["sql"];

function must<T>(v: T | null | undefined, what = "value"): T {
  assert.ok(v !== null && v !== undefined, `${what} missing`);
  return v;
}

async function runMigration(sql: Sql, tag: string): Promise<void> {
  const text = readFileSync(resolve(MIGRATIONS, `${tag}.sql`), "utf8");
  await sql.begin(async (tx) => {
    for (const stmt of text.split("--> statement-breakpoint")) {
      if (stmt.trim()) await tx.unsafe(stmt);
    }
  });
}

async function prepareSchema(sql: Sql): Promise<void> {
  const [probe] = await sql<{ base: string | null; f12: string | null }[]>`
    SELECT to_regclass('public.tenant_provisioning_jobs')::text AS base,
           to_regclass('public.template_assignments')::text AS f12`;
  if (probe?.f12) return;
  if (probe?.base) {
    await runMigration(sql, "0136_template_applicability");
    return;
  }
  await sql.unsafe(SUPABASE_STUBS);
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const e of journal.entries) await runMigration(sql, e.tag);
}

const TENANT_TABLES = [
  "api_audit_logs",
  "interview_plans",
  "requisition_state_transitions",
  "requisitions",
  "jd_versions",
  "positions",
  "template_assignments",
  "tenant_interview_round_template",
  "interview_loops",
  "tenant_scorecard_template",
  "comp_bands",
  "job_profiles",
  "job_levels",
  "job_functions",
  "jd_templates",
  "tenant_lookups",
  "panel_pools",
  "candidate_field_policy",
  "tenant_email_template_overrides",
  "tenant_application_sources",
  "approval_matrices",
];

async function cleanup(sql: Sql): Promise<void> {
  for (const t of [T, T2]) {
    for (const table of TENANT_TABLES) {
      const [ok] = await sql<
        { r: string | null }[]
      >`SELECT to_regclass(${`public.${table}`})::text AS r`;
      if (ok?.r) await sql.unsafe(`DELETE FROM public.${table} WHERE tenant_id = $1`, [t]);
    }
    await sql`UPDATE public.business_units SET legal_entity_id = NULL, parent_business_unit_id = NULL WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.locations WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.business_units WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.legal_entities WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenants WHERE id = ${t}`;
  }
  await sql`DELETE FROM auth.users WHERE id = ${U}`;
}

describe.skipIf(!HAS_LOCAL_PG)("C2-F12 applicability resolver (local Postgres)", () => {
  let db: DbModule;
  let sql: Sql;
  let appRouter: typeof import("../src/trpc/router").appRouter;
  let log: import("@hireops/observability").Logger;

  function caller(roles: string[], tenantId = T) {
    return appRouter.createCaller({
      tenantId,
      userId: U,
      roles,
      claims: { sub: U, tid: tenantId, roles },
      db: undefined,
      sql: db.sql,
      log,
      requestId: `f12-${Math.random().toString(36).slice(2)}`,
      userAgent: null,
      ipAddress: null,
    });
  }
  const admin = () => caller(["admin"]);

  async function expectTrpc(p: Promise<unknown>, code: string, message?: string): Promise<void> {
    try {
      await p;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
      if (message)
        assert.ok(e.message?.includes(message), `message "${e.message}" lacks ${message}`);
      return;
    }
    assert.fail(`expected ${code}, but the call succeeded`);
  }

  async function plan(reqId: string) {
    return sql<{ round_number: number; round_name: string; scorecard_template: string }[]>`
      SELECT round_number, round_name, scorecard_template FROM public.interview_plans
       WHERE tenant_id = ${T} AND requisition_id = ${reqId} ORDER BY round_number`;
  }

  async function loopId(key: string, tenantId = T): Promise<string> {
    const loops = (await caller(["admin"], tenantId).listInterviewLoops({})).loops;
    return must(
      loops.find((l) => l.loopKey === key),
      `loop ${key}`,
    ).id;
  }
  async function scorecardId(key: string): Promise<string> {
    const [r] = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenant_scorecard_template WHERE tenant_id = ${T} AND scorecard_key = ${key}`;
    return must(r, `scorecard ${key}`).id;
  }

  beforeAll(async () => {
    if (!LOCAL_PG_URL) return;
    db = await loadLocalDb();
    sql = db.sql;
    await prepareSchema(sql);
    await import("../src/bootstrap");
    ({ appRouter } = await import("../src/trpc/router"));
    log = (await import("@hireops/observability")).createLogger({ level: "error" });
    await cleanup(sql);

    await sql`INSERT INTO auth.users (id, email) VALUES (${U}, 'admin@f12.test') ON CONFLICT DO NOTHING`;
    for (const [t, slug] of [
      [T, "f12-src"],
      [T2, "f12-target"],
    ] as const) {
      await sql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
                VALUES (${t}, ${slug}, ${slug}, 'ap-south-1', 'active')`;
    }
    await sql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status)
              VALUES (${M}, ${T}, ${U}, '{admin}', 'active'), (${M2}, ${T2}, ${U}, '{admin}', 'active')`;
    await sql`INSERT INTO public.legal_entities (id, tenant_id, name, country_code)
              VALUES (${E_IN}, ${T}, 'India Pvt Ltd', 'IN'), (${E_US}, ${T}, 'US Inc', 'US')`;
    await sql`INSERT INTO public.business_units (id, tenant_id, name, slug, legal_entity_id)
              VALUES (${BU_FIN}, ${T}, 'Finance', 'finance', ${E_IN}),
                     (${BU_HR}, ${T}, 'HR', 'hr', NULL),
                     (${BU_FOREIGN}, ${T2}, 'Elsewhere', 'elsewhere', NULL)`;
    await sql`INSERT INTO public.business_units (id, tenant_id, name, slug, parent_business_unit_id)
              VALUES (${BU_AP}, ${T}, 'Accounts Payable', 'ap', ${BU_FIN})`;
    await sql`INSERT INTO public.locations (id, tenant_id, name, city, country_code, legal_entity_id, timezone)
              VALUES (${LOC_HYD}, ${T}, 'Hyderabad', 'Hyderabad', 'IN', ${E_IN}, 'Asia/Kolkata')`;
    await sql`INSERT INTO public.job_functions (id, tenant_id, key, label) VALUES (${FN_R2R}, ${T}, 'r2r', 'Record to Report')`;
    await sql`INSERT INTO public.job_levels (id, tenant_id, key, label, rank)
              VALUES (${LV12}, ${T}, 'IN12', 'IN12', 12), (${LV15}, ${T}, 'IN15', 'IN15', 15)`;
    await sql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title)
              VALUES (${P_AP}, ${T}, ${BU_AP}, 'AP Lead'), (${P_HR}, ${T}, ${BU_HR}, 'HR Associate')`;
    await sql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text)
              VALUES (${JD_AP}, ${T}, ${P_AP}, 1, 'jd'), (${JD_HR}, ${T}, ${P_HR}, 1, 'jd')`;
    await sql`INSERT INTO public.requisitions
                (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id,
                 location_id, job_function_id, job_level_id, employment_type_key)
              VALUES (${R_AP15}, ${T}, ${P_AP}, ${JD_AP}, ${M}, ${M}, ${LOC_HYD}, ${FN_R2R}, ${LV15}, 'permanent'),
                     (${R_HR12}, ${T}, ${P_HR}, ${JD_HR}, ${M}, ${M}, NULL, NULL, ${LV12}, NULL)`;

    // Scorecards + loops.
    const a = admin();
    await a.upsertScorecardTemplate({
      scorecardKey: "sc_senior",
      label: "Senior",
      criteria: [{ key: "leadership", label: "Leadership" }],
    });
    await a.upsertScorecardTemplate({
      scorecardKey: "sc_basic",
      label: "Basic",
      criteria: [{ key: "basics", label: "Basics" }],
    });
    await a.upsertInterviewRoundTemplate({
      rounds: [
        {
          roundNumber: 1,
          roundName: "Screen",
          durationMinutes: 30,
          mode: "phone",
          scorecardTemplateKey: "general",
          competencyFocus: [],
        },
        {
          roundNumber: 2,
          roundName: "Panel",
          durationMinutes: 60,
          mode: "video",
          scorecardTemplateKey: null,
          competencyFocus: [],
        },
      ],
    });
    await expectTrpc(
      a.upsertInterviewRoundTemplate({ loopKey: "senior", rounds: [] }),
      "BAD_REQUEST",
      "Create the loop first",
    );
    await a.createInterviewLoop({ loopKey: "senior", label: "Senior loop" });
    await a.upsertInterviewRoundTemplate({
      loopKey: "senior",
      rounds: [
        {
          roundNumber: 1,
          roundName: "Leadership panel",
          durationMinutes: 90,
          mode: "onsite",
          scorecardTemplateKey: null,
          competencyFocus: ["leadership"],
        },
      ],
    });
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("named loops: the default loop exists, rounds are per loop, default can't be deactivated", async () => {
    const loops = (await admin().listInterviewLoops({})).loops;
    assert.deepEqual(
      loops.map((l) => [l.loopKey, l.isDefault, l.roundCount]),
      [
        ["default", true, 2],
        ["senior", false, 1],
      ],
    );
    const senior = await admin().listInterviewRoundTemplates({ loopKey: "senior" });
    assert.equal(senior.rounds.length, 1);
    assert.equal(senior.rounds[0]?.scorecardTemplateKey, null);
    const def = await admin().listInterviewRoundTemplates({});
    assert.equal(def.rounds.length, 2);
    await expectTrpc(
      admin().updateInterviewLoop({ id: await loopId("default"), label: "X", isActive: false }),
      "BAD_REQUEST",
    );
    await expectTrpc(
      admin().createInterviewLoop({ loopKey: "senior", label: "dup" }),
      "BAD_REQUEST",
      "already exists",
    );
  });

  it("role gates: admin write, hr_head read + preview, everyone else forbidden", async () => {
    const hr = caller(["hr_head"]);
    const list = await hr.listTemplateAssignments({});
    assert.equal(list.canWrite, false);
    await hr.previewResolvedConfiguration({ requisitionId: R_AP15 });
    await hr.listInterviewLoops({});
    const loop = await loopId("default");
    await expectTrpc(
      hr.createTemplateAssignment({ templateKind: "interview_loop", name: "x", templateId: loop }),
      "FORBIDDEN",
    );
    await expectTrpc(hr.createInterviewLoop({ loopKey: "x", label: "x" }), "FORBIDDEN");
    for (const role of ["recruiter", "hiring_manager", "panel_member"]) {
      const c = caller([role]);
      await expectTrpc(c.listTemplateAssignments({}), "FORBIDDEN");
      await expectTrpc(c.previewResolvedConfiguration({ requisitionId: R_AP15 }), "FORBIDDEN");
      await expectTrpc(
        c.createTemplateAssignment({ templateKind: "interview_loop", name: "x", templateId: loop }),
        "FORBIDDEN",
      );
    }
    assert.equal((await admin().listTemplateAssignments({})).canWrite, true);
  });

  it("no assignments: plan seeding falls back to the default loop + pinned / 'general' scorecard", async () => {
    const out = await admin().applyInterviewRoundTemplate({ requisitionId: R_AP15 });
    assert.equal(out.applied, true);
    assert.equal(out.loopKey, "default");
    assert.equal(out.assignmentId, null);
    assert.deepEqual(
      (await plan(R_AP15)).map((r) => [r.round_name, r.scorecard_template]),
      [
        ["Screen", "general"],
        ["Panel", "general"],
      ],
    );
    const preview = await admin().previewResolvedConfiguration({ requisitionId: R_AP15 });
    for (const k of preview.kinds) assert.equal(k.winner, null, k.kind);
    assert.equal(preview.kinds.length, 8);
  });

  it("write validation: unconsumed kind, foreign target, foreign condition id, duplicate name", async () => {
    const a = admin();
    const loop = await loopId("default");
    await expectTrpc(
      a.createTemplateAssignment({ templateKind: "bgv_package", name: "x", templateId: loop }),
      "BAD_REQUEST",
      "can't be assigned yet",
    );
    await expectTrpc(
      a.createTemplateAssignment({
        templateKind: "interview_loop",
        name: "x",
        templateId: await loopId("default", T2),
      }),
      "BAD_REQUEST",
      "not found",
    );
    await expectTrpc(
      a.createTemplateAssignment({
        templateKind: "scorecard",
        name: "x",
        templateId: loop,
      }),
      "BAD_REQUEST",
    );
    await expectTrpc(
      a.createTemplateAssignment({
        templateKind: "interview_loop",
        name: "x",
        templateId: loop,
        conditions: { business_unit_id: { in: [BU_FOREIGN] } },
      }),
      "BAD_REQUEST",
      "Business unit",
    );
    await expectTrpc(
      a.createTemplateAssignment({
        templateKind: "interview_loop",
        name: "x",
        templateId: loop,
        conditions: { job_level_rank: { min: 20, max: 10 } },
      }),
      "BAD_REQUEST",
    );
    await a.createTemplateAssignment({
      templateKind: "interview_loop",
      name: "Default loop",
      templateId: loop,
    });
    await expectTrpc(
      a.createTemplateAssignment({
        templateKind: "interview_loop",
        name: "Default loop",
        templateId: loop,
      }),
      "BAD_REQUEST",
      "already exists",
    );
  });

  it("resolves per requisition: BU descendants + level rank + entity, most specific wins", async () => {
    const a = admin();
    await a.createTemplateAssignment({
      templateKind: "interview_loop",
      name: "Senior finance",
      templateId: await loopId("senior"),
      conditions: { business_unit_id: { in: [BU_FIN] }, job_level_rank: { min: 14 } },
    });
    await a.createTemplateAssignment({
      templateKind: "scorecard",
      name: "India senior scorecard",
      templateId: await scorecardId("sc_senior"),
      conditions: { legal_entity_id: { in: [E_IN] }, country_code: { in: ["IN"] } },
    });

    const p = await a.previewResolvedConfiguration({ requisitionId: R_AP15 });
    assert.deepEqual(p.subject.businessUnitLineage, [BU_AP, BU_FIN]);
    assert.equal(p.subject.legalEntityId, E_IN);
    assert.equal(p.subject.countryCode, "IN");
    assert.equal(p.subject.jobLevelRank, 15);
    const loop = must(p.kinds.find((k) => k.kind === "interview_loop"));
    assert.equal(loop.winner?.name, "Senior finance");
    assert.deepEqual(loop.winner?.matchedPredicates, ["business_unit_id", "job_level_rank"]);
    assert.equal(loop.evaluated.length, 2);
    const sc = must(p.kinds.find((k) => k.kind === "scorecard"));
    assert.equal(sc.winner?.templateLabel, "Senior");
    assert.deepEqual(sc.winner?.matchedPredicates, ["legal_entity_id", "country_code"]);

    // HR req: rank 12, no entity anywhere → default loop, no scorecard winner.
    const h = await a.previewResolvedConfiguration({ requisitionId: R_HR12 });
    assert.equal(h.subject.legalEntityId, null);
    const hl = must(h.kinds.find((k) => k.kind === "interview_loop"));
    assert.equal(hl.winner?.name, "Default loop");
    assert.equal(hl.winner?.isDefault, true);
    const failed = must(hl.evaluated.find((e) => e.name === "Senior finance"));
    assert.deepEqual(failed.failedPredicates, ["business_unit_id", "job_level_rank"]);
    assert.equal(must(h.kinds.find((k) => k.kind === "scorecard")).winner, null);

    // What-if by attributes: AP at IN12 → the rank predicate fails → default.
    const w = await a.previewResolvedConfiguration({
      attributes: { businessUnitId: BU_AP, jobLevelId: LV12 },
    });
    assert.equal(w.requisitionId, null);
    assert.equal(w.subject.legalEntityId, E_IN, "entity derived up the BU lineage");
    assert.equal(
      must(w.kinds.find((k) => k.kind === "interview_loop")).winner?.name,
      "Default loop",
    );
    await expectTrpc(a.previewResolvedConfiguration({ requisitionId: id(0xfff) }), "NOT_FOUND");
  });

  it("plan seeding resolves the loop; applicability fills only unpinned scorecards", async () => {
    const a = admin();
    const out = await a.applyInterviewRoundTemplate({ requisitionId: R_AP15 });
    assert.equal(out.loopKey, "senior");
    assert.ok(out.assignmentId);
    assert.deepEqual(out.matchedPredicates, ["business_unit_id", "job_level_rank"]);
    assert.deepEqual(
      (await plan(R_AP15)).map((r) => [r.round_name, r.scorecard_template]),
      [["Leadership panel", "sc_senior"]],
    );

    // HR req: default loop; no scorecard winner → 'general' for the gap.
    await a.applyInterviewRoundTemplate({ requisitionId: R_HR12 });
    assert.deepEqual(
      (await plan(R_HR12)).map((r) => r.scorecard_template),
      ["general", "general"],
    );
    // A default scorecard rule now fills the gap — the pinned round is untouched.
    await a.createTemplateAssignment({
      templateKind: "scorecard",
      name: "Default scorecard",
      templateId: await scorecardId("sc_basic"),
    });
    await a.applyInterviewRoundTemplate({ requisitionId: R_HR12 });
    assert.deepEqual(
      (await plan(R_HR12)).map((r) => r.scorecard_template),
      ["general", "sc_basic"],
    );
    // An explicit loop key overrides applicability.
    const explicit = await a.applyInterviewRoundTemplate({
      requisitionId: R_AP15,
      loopKey: "default",
    });
    assert.equal(explicit.loopKey, "default");
    assert.equal((await plan(R_AP15)).length, 2);
    // An inactive target is skipped → falls through to the next match.
    await a.updateInterviewLoop({
      id: await loopId("senior"),
      label: "Senior loop",
      isActive: false,
    });
    const fell = await a.applyInterviewRoundTemplate({ requisitionId: R_AP15 });
    assert.equal(fell.loopKey, "default");
    await a.updateInterviewLoop({
      id: await loopId("senior"),
      label: "Senior loop",
      isActive: true,
    });
  });

  it("a scorecard referenced by an assignment can't be deleted; update + delete assignments", async () => {
    const a = admin();
    await expectTrpc(
      a.deleteScorecardTemplate({ scorecardKey: "sc_senior" }),
      "BAD_REQUEST",
      "India senior scorecard",
    );
    const list = await a.listTemplateAssignments({ templateKind: "scorecard" });
    assert.equal(list.assignments.length, 2);
    assert.ok(list.targets.every((t) => t.kind === "scorecard"));
    const row = must(list.assignments.find((r) => r.name === "Default scorecard"));
    const upd = await a.updateTemplateAssignment({
      id: row.id,
      name: "Default scorecard",
      templateId: row.templateId,
      priority: 5,
      isActive: false,
      conditions: {},
    });
    assert.equal(upd.row.priority, 5);
    assert.equal(upd.row.isActive, false);
    await a.updateTemplateAssignment({ ...upd.row, isActive: true });
    const tmp = await a.createTemplateAssignment({
      templateKind: "scorecard",
      name: "Temp",
      templateId: row.templateId,
    });
    assert.equal((await a.deleteTemplateAssignment({ id: tmp.row.id })).deleted, true);
    assert.equal((await a.deleteTemplateAssignment({ id: tmp.row.id })).deleted, false);
  });

  it("export → import round trip carries loops, rounds and assignments by natural key", async () => {
    const exported = await admin().exportTenantConfig();
    const s = exported.document.sections;
    assert.deepEqual(
      s.interviewLoops?.map((l) => l.loopKey),
      ["default", "senior"],
    );
    assert.equal(
      s.interviewRounds?.find((r) => r.loopKey === "senior")?.scorecardTemplateKey,
      null,
    );
    const senior = must(s.templateAssignments?.find((x) => x.name === "Senior finance"));
    assert.equal(senior.template, "senior");
    assert.deepEqual(senior.conditions, {
      business_unit_id: { in: ["finance"] },
      job_level_rank: { min: 14 },
    });
    const india = must(s.templateAssignments?.find((x) => x.name === "India senior scorecard"));
    assert.deepEqual(india.conditions.legal_entity_id, { in: ["India Pvt Ltd"] });
    assert.ok(!JSON.stringify(s.templateAssignments).includes(BU_FIN), "no ids in the export");

    const target = caller(["admin"], T2);
    const preview = await target.previewTenantConfigImport({ document: exported.document });
    assert.equal(preview.ok, true, preview.error ?? "");
    const sec = Object.fromEntries(preview.diff.map((d) => [d.section, d]));
    assert.equal(sec.templateAssignments?.adds.length, 4);
    const applied = await target.applyTenantConfigImport({
      document: exported.document,
      fingerprint: must(preview.fingerprint),
    });
    assert.deepEqual(
      applied.skipped.filter((x) => x.startsWith("templateAssignments")),
      [],
    );
    const back = await target.exportTenantConfig();
    for (const k of ["interviewLoops", "interviewRounds", "templateAssignments"] as const) {
      assert.deepEqual(back.document.sections[k], s[k], k);
    }
    const again = await target.previewTenantConfigImport({ document: exported.document });
    const leftovers = again.diff.filter((d) =>
      ["interviewLoops", "interviewRounds", "templateAssignments"].includes(d.section),
    );
    for (const d of leftovers) {
      assert.equal(d.adds.length + d.changes.length + d.removals.length, 0, JSON.stringify(d));
    }

    // Imported ids are the TARGET's ids, and the target resolves on its own.
    const [row] = await sql<{ conditions: { business_unit_id?: { in: string[] } } }[]>`
      SELECT conditions FROM public.template_assignments
       WHERE tenant_id = ${T2} AND name = 'Senior finance'`;
    const [fin2] = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM public.business_units WHERE tenant_id = ${T2} AND slug = 'finance'`;
    assert.deepEqual(row?.conditions.business_unit_id?.in, [must(fin2).id]);

    // Removal on import: drop one assignment from the document.
    const doc = structuredClone(exported.document);
    doc.sections.templateAssignments = must(doc.sections.templateAssignments).filter(
      (x) => x.name !== "Temp" && x.name !== "Default scorecard",
    );
    const p2 = await target.previewTenantConfigImport({ document: doc });
    assert.deepEqual(p2.diff.find((d) => d.section === "templateAssignments")?.removals, [
      "scorecard:Default scorecard",
    ]);
    await target.applyTenantConfigImport({ document: doc, fingerprint: must(p2.fingerprint) });
    const names = (await target.listTemplateAssignments({})).assignments.map((x) => x.name).sort();
    assert.deepEqual(names, ["Default loop", "India senior scorecard", "Senior finance"]);
  });

  it("tenant isolation: each tenant sees only its own assignments", async () => {
    const mine = (await admin().listTemplateAssignments({})).assignments.map((x) => x.id);
    const theirs = (await caller(["admin"], T2).listTemplateAssignments({})).assignments.map(
      (x) => x.id,
    );
    assert.ok(mine.length > 0 && theirs.length > 0);
    assert.equal(
      mine.filter((x) => theirs.includes(x)).length,
      0,
      "no assignment visible to both tenants",
    );
    // A foreign assignment id can't be edited.
    await expectTrpc(
      caller(["admin"], T2).updateTemplateAssignment({
        id: must(mine[0]),
        name: "hijack",
        templateId: await loopId("default", T2),
        priority: 0,
        isActive: true,
        conditions: {},
      }),
      "NOT_FOUND",
    );
  });
});
