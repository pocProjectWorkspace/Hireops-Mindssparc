/**
 * PC-26 — diverse-slate requirement per role.
 *
 * REQUIRES MIGRATION 0126 (candidate_diversity_self_id + requisitions.
 * diverse_slate_required / diverse_slate_min). Fails on relation/column-not-
 * found until applied.
 *
 * Self-contained synthetic tenant ('c26' namespace) whose tenants.settings
 * carries an ENABLED diversitySlate block with a test-only category
 * ('pc26cat': pc26_yes counts, pc26_no does not) so the "raw values never
 * leak" checks look for strings that cannot occur by accident.
 *
 * Fixture on REQ (diverse slate required, min = tenant default 2):
 *   P1 shortlisted        pc26_yes active      → counts
 *   P2 tech_interview     pc26_yes active      → counts (candidate account A)
 *   P3 hr_round           pc26_yes WITHDRAWN   → ignored
 *   P4 application_recv.  pc26_yes active      → stage not counted
 *   P5 offer_drafted      pc26_no  active      → value not qualifying
 * REQ2: same tenant, requirement off → not_required.
 *
 *   1. count correctness (stages, withdrawn ignored, non-qualifying ignored)
 *   2. role minimum overrides the tenant default
 *   3. categories + counted stages come from tenant config
 *   4. candidate portal: withdraw via "prefer not to say", re-answer, version check
 *   5. role gate on the slate endpoints + settings
 *   6. raw values never in candidate detail / list / by-role outputs
 *   7. RLS: staff claims see zero rows; candidate claims see their own
 *   8. audit trail redacts the value
 *   9. the public apply-form path is fill-only (never overwrites / withdraws)
 *
 * Requires the fnd15b test user (same as cand-03). Cleans up in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { TRPCError } from "@trpc/server";
import { sql as poolSql, db as poolDb, withTenantContext, drizzleSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import {
  DIVERSITY_PREFER_NOT_TO_SAY,
  DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
  type DiversitySlateSettings,
} from "@hireops/api-types";
import { appRouter } from "../src/trpc/router";
import { applySelfIdSubmission } from "../src/lib/diversity-slate";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
}

const T = "00000000-0000-4000-8000-000000c26a01";
const BU = "00000000-0000-4000-8000-000000c26a02";
const MEM = "00000000-0000-4000-8000-000000c26a03";
const POS = "00000000-0000-4000-8000-000000c26a04";
const POS2 = "00000000-0000-4000-8000-000000c26a05";
const JD = "00000000-0000-4000-8000-000000c26a06";
const JD2 = "00000000-0000-4000-8000-000000c26a07";
const REQ = "00000000-0000-4000-8000-000000c26a08";
const REQ2 = "00000000-0000-4000-8000-000000c26a09";
const P = [1, 2, 3, 4, 5].map((i) => `00000000-0000-4000-8000-000000c26b0${i}`);
const C = [1, 2, 3, 4, 5].map((i) => `00000000-0000-4000-8000-000000c26c0${i}`);
const A = [1, 2, 3, 4, 5].map((i) => `00000000-0000-4000-8000-000000c26d0${i}`);
const STAGES = [
  "shortlisted",
  "tech_interview",
  "hr_round",
  "application_received",
  "offer_drafted",
];

const CAND_EMAIL = "cand-pc26@hireops-dev.local";
const CAND_PASSWORD = "pc26-test-password-do-not-reuse";

const SETTINGS: DiversitySlateSettings = {
  version: 1,
  enabled: true,
  defaultMin: 2,
  countedStages: ["shortlisted", "tech_interview", "hr_round", "offer_drafted"],
  categories: [
    {
      key: "pc26cat",
      label: "PC26 test question",
      options: [
        { value: "pc26_yes", label: "Yes", countsAsDiverse: true },
        { value: "pc26_no", label: "No", countsAsDiverse: false },
      ],
    },
  ],
};
const LEAK = /pc26_yes|pc26_no|pc26cat|diversity|selfId/i;

const log = createLogger({ level: "error" });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let staffUserId: string;
let candAuthId: string;

function staff(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: T,
    userId: staffUserId,
    roles,
    claims: { sub: staffUserId, tid: T, tenant_slug: "synth-pc26", roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-pc26-${randomUUID()}`,
    userAgent: "pc26-test",
    ipAddress: "127.0.0.1",
  };
  return appRouter.createCaller(ctx);
}
function candidate() {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId: candAuthId,
    roles: [],
    claims: { sub: candAuthId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-pc26-${randomUUID()}`,
    userAgent: "pc26-test",
    ipAddress: "127.0.0.1",
  };
  return appRouter.createCaller(ctx);
}

async function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof TRPCError, `${label}: expected a TRPCError, got ${String(thrown)}`);
  assert.equal((thrown as TRPCError).code, code, `${label}: expected ${code}`);
}

async function slate(reqId = REQ) {
  return staff(["recruiter"]).getDiverseSlateStatus({ requisitionId: reqId });
}

async function cleanup(): Promise<void> {
  const steps = [
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidate_diversity_self_id WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
  ];
  for (const run of steps) {
    try {
      await run();
    } catch (err) {
      console.warn("PC-26 cleanup step failed (continuing):", err);
    }
  }
}

describe("PC-26 diverse slate", () => {
  beforeAll(async () => {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
    staffUserId = decodeJwt(data.session.access_token).sub as string;

    const created = await admin.auth.admin.createUser({
      email: CAND_EMAIL,
      password: CAND_PASSWORD,
      email_confirm: true,
    });
    let id = created.data?.user?.id ?? null;
    if (!id) {
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      id = list.data?.users.find((u) => u.email === CAND_EMAIL)?.id ?? null;
    }
    if (!id) throw new Error("could not create/find the PC-26 candidate auth user");
    candAuthId = id;

    await cleanup();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${T}, 'synth-pc26', 'PC-26 Synth', 'ap-northeast-1', 'active',
              ${poolSql.json({ diversitySlate: SETTINGS } as never)})`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, 'PC26 BU', 'pc26-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEM}, ${T}, ${staffUserId}, ARRAY['recruiter','admin']::tenant_role[], 'active', ${BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
      VALUES (${POS}, ${T}, ${BU}, 'PC26 Analyst', 'hybrid', 'Pune', true)`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
      VALUES (${POS2}, ${T}, ${BU}, 'PC26 Other', 'hybrid', 'Pune', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${JD}, ${T}, ${POS}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${JD2}, ${T}, ${POS2}, 1, '# JD2', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, diverse_slate_required)
      VALUES (${REQ}, ${T}, ${POS}, ${JD}, ${MEM}, ${MEM}, 'posted', true)`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ2}, ${T}, ${POS2}, ${JD2}, ${MEM}, ${MEM}, 'posted')`;
    for (let i = 0; i < 5; i++) {
      await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
        VALUES (${P[i]!}, ${T}, ${`PC26 Person ${i + 1}`}, ${`pc26-p${i + 1}@example.test`}, ${`pc26-p${i + 1}@example.test`})`;
      await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${C[i]!}, ${T}, ${P[i]!}, 'career_site')`;
      await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage)
        VALUES (${A[i]!}, ${T}, ${C[i]!}, ${REQ}, 'career_site', ${STAGES[i]!}::application_stage)`;
    }
    const answers: [number, string, boolean][] = [
      [0, "pc26_yes", false],
      [1, "pc26_yes", false],
      [2, "pc26_yes", true],
      [3, "pc26_yes", false],
      [4, "pc26_no", false],
    ];
    for (const [i, value, withdrawn] of answers) {
      await poolSql`INSERT INTO public.candidate_diversity_self_id
          (tenant_id, person_id, category_key, value, disclosure_version, collected_via, withdrawn_at)
        VALUES (${T}, ${P[i]!}, 'pc26cat', ${value}, ${DIVERSITY_SELF_ID_DISCLOSURE_VERSION}, 'apply_form',
                ${withdrawn ? new Date() : null})`;
    }
    // P2 owns the candidate portal account.
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at)
      VALUES (${T}, ${P[1]!}, ${candAuthId}, 'active', now())`;
  });

  afterAll(async () => {
    await cleanup();
    await admin.auth.admin.deleteUser(candAuthId).catch(() => undefined);
    await poolSql.end({ timeout: 10 });
  });

  it("1. counts distinct persons in counted stages with an active qualifying answer", async () => {
    const s = await slate();
    assert.deepEqual(s, { requisitionId: REQ, status: "met", requiredMin: 2, diverseInSlate: 2 });
    const s2 = await slate(REQ2);
    assert.equal(s2.status, "not_required");
    assert.equal(s2.diverseInSlate, null, "no numbers for a role without the requirement");
    // Same answer via an application id.
    const viaApp = await staff(["recruiter"]).getDiverseSlateStatus({ applicationId: A[0]! });
    assert.equal(viaApp.diverseInSlate, 2);
  });

  it("2. the role's own minimum overrides the tenant default", async () => {
    await poolSql`UPDATE public.requisitions SET diverse_slate_min = 3 WHERE id = ${REQ}`;
    try {
      const s = await slate();
      assert.equal(s.status, "short");
      assert.equal(s.requiredMin, 3);
      const list = await staff(["hr_head"]).listDiverseSlateStatuses({ onlyShort: true });
      assert.equal(list.enabled, true);
      assert.deepEqual(
        list.rows.map((r) => r.requisitionId),
        [REQ],
      );
      assert.deepEqual(Object.keys(list.rows[0]!).sort(), [
        "diverseInSlate",
        "requiredMin",
        "requisitionId",
        "status",
        "title",
      ]);
    } finally {
      await poolSql`UPDATE public.requisitions SET diverse_slate_min = NULL WHERE id = ${REQ}`;
    }
  });

  it("3. qualifying values and counted stages come from tenant configuration", async () => {
    const adminCaller = staff(["admin"]);
    try {
      await adminCaller.updateDiversitySlateSettings({
        ...SETTINGS,
        categories: [
          {
            ...SETTINGS.categories[0]!,
            options: SETTINGS.categories[0]!.options.map((o) => ({ ...o, countsAsDiverse: true })),
          },
        ],
      });
      assert.equal((await slate()).diverseInSlate, 3, "pc26_no now counts → P5 included");

      await adminCaller.updateDiversitySlateSettings({
        ...SETTINGS,
        countedStages: [...SETTINGS.countedStages, "application_received"],
      });
      assert.equal((await slate()).diverseInSlate, 3, "application_received counted → P4 included");

      await adminCaller.updateDiversitySlateSettings({ ...SETTINGS, enabled: false });
      assert.equal((await slate()).status, "not_required", "tenant off → nothing flagged");
      const off = await adminCaller.listDiverseSlateStatuses({ onlyShort: false });
      assert.deepEqual(off, { enabled: false, rows: [] });
    } finally {
      await poolSql`UPDATE public.tenants SET settings = ${poolSql.json({ diversitySlate: SETTINGS } as never)} WHERE id = ${T}`;
    }
    assert.equal((await slate()).diverseInSlate, 2);
  });

  it("4. candidate portal: withdraw via prefer-not-to-say, re-answer, version check", async () => {
    const mine = await candidate().candidateGetDiversitySelfId();
    assert.deepEqual(mine.answers, [{ categoryKey: "pc26cat", value: "pc26_yes" }]);
    assert.ok(!JSON.stringify(mine.config).includes("countsAsDiverse"));

    const withdrawn = await candidate().candidateSetDiversitySelfId({
      disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
      answers: [{ categoryKey: "pc26cat", value: DIVERSITY_PREFER_NOT_TO_SAY }],
    });
    assert.deepEqual(withdrawn.answers, []);
    const s = await slate();
    assert.equal(s.diverseInSlate, 1);
    assert.equal(s.status, "short");

    const [stored] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.candidate_diversity_self_id
      WHERE tenant_id = ${T} AND person_id = ${P[1]!} AND value = ${DIVERSITY_PREFER_NOT_TO_SAY}`;
    assert.equal(stored!.n, 0, "prefer-not-to-say is never stored");

    await candidate().candidateSetDiversitySelfId({
      disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
      answers: [{ categoryKey: "pc26cat", value: "pc26_yes" }],
    });
    assert.equal((await slate()).diverseInSlate, 2);

    const [via] = await poolSql<{ collected_via: string; disclosure_version: string }[]>`
      SELECT collected_via, disclosure_version FROM public.candidate_diversity_self_id
      WHERE tenant_id = ${T} AND person_id = ${P[1]!} AND withdrawn_at IS NULL`;
    assert.equal(via!.collected_via, "candidate_portal");
    assert.equal(via!.disclosure_version, DIVERSITY_SELF_ID_DISCLOSURE_VERSION);

    await expectCode(
      () =>
        candidate().candidateSetDiversitySelfId({
          disclosureVersion: "some-old-version",
          answers: [{ categoryKey: "pc26cat", value: "pc26_no" }],
        }),
      "BAD_REQUEST",
      "stale disclosure version",
    );
  });

  it("5. role gate — counts for admin / hr_head / recruiter only; settings for admin / hr_head", async () => {
    for (const roles of [["hiring_manager"], ["panel_member"], ["hr_ops"]]) {
      await expectCode(
        () => staff(roles).getDiverseSlateStatus({ requisitionId: REQ }),
        "FORBIDDEN",
        `status as ${roles[0]}`,
      );
      await expectCode(
        () => staff(roles).listDiverseSlateStatuses({ onlyShort: false }),
        "FORBIDDEN",
        `list as ${roles[0]}`,
      );
      await expectCode(
        () => staff(roles).getDiversitySlateSettings(),
        "FORBIDDEN",
        `settings as ${roles[0]}`,
      );
    }
    for (const roles of [["admin"], ["hr_head"], ["recruiter"]]) {
      const s = await staff(roles).getDiverseSlateStatus({ requisitionId: REQ });
      assert.equal(s.diverseInSlate, 2, `status as ${roles[0]}`);
    }
    await expectCode(
      () => staff(["recruiter"]).updateDiversitySlateSettings(SETTINGS),
      "FORBIDDEN",
      "recruiter cannot edit settings",
    );
    // Partner / candidate surfaces can't reach the staff endpoint at all.
    await expectCode(
      () => candidate().getDiverseSlateStatus({ requisitionId: REQ }),
      "UNAUTHORIZED",
      "candidate on staff endpoint",
    );
  });

  it("6. raw self-ID values never appear in candidate detail / list / by-role outputs", async () => {
    const caller = staff(["recruiter", "admin"]);
    for (let i = 0; i < 5; i++) {
      const d = await caller.getCandidateById({ id: C[i]!, applicationId: A[i]! });
      assert.ok(!LEAK.test(JSON.stringify(d)), `getCandidateById P${i + 1}`);
    }
    const list = await caller.listCandidates({ filters: { requisitionId: REQ } } as never);
    assert.ok(!LEAK.test(JSON.stringify(list)), "listCandidates");
    const byRole = await caller.listCandidatesByRequisition({});
    assert.ok(!LEAK.test(JSON.stringify(byRole)), "listCandidatesByRequisition");
    const status = await caller.getDiverseSlateStatus({ requisitionId: REQ });
    assert.ok(!JSON.stringify(status).includes(P[0]!), "slate status carries no person id");
  });

  it("7. RLS — staff claims see zero rows; the candidate sees only their own", async () => {
    const staffRows = await withTenantContext(
      {
        sub: staffUserId,
        tid: T,
        tenant_slug: "synth-pc26",
        roles: ["admin", "recruiter", "hr_head"],
      },
      async ({ db }) =>
        db.execute(drizzleSql`SELECT count(*)::int AS n FROM public.candidate_diversity_self_id`),
    );
    const sRows = (staffRows as unknown as { n: number }[]) ?? [];
    assert.equal(Number(sRows[0]?.n ?? 0), 0, "staff RLS sees nothing");

    const candRows = await withTenantContext(
      { sub: candAuthId, tid: T, tenant_slug: "synth-pc26", roles: ["candidate"] },
      async ({ db }) =>
        db.execute(drizzleSql`SELECT count(*)::int AS n FROM public.candidate_diversity_self_id`),
    );
    const cRows = (candRows as unknown as { n: number }[]) ?? [];
    assert.ok(Number(cRows[0]?.n ?? 0) > 0, "candidate claims pass the policy");
  });

  it("8. the audit trail records changes with the value redacted", async () => {
    const rows = await poolSql<{ before: unknown; after: unknown }[]>`
      SELECT before_data AS before, after_data AS after FROM public.audit_logs
      WHERE tenant_id = ${T} AND entity_type = 'candidate_diversity_self_id'`;
    assert.ok(rows.length > 0, "audit rows written");
    for (const r of rows) {
      const blob = JSON.stringify(r);
      assert.ok(!/pc26_yes|pc26_no/.test(blob), "value redacted in audit_logs");
    }
    const api = await poolSql<{ input_json: unknown }[]>`
      SELECT input_json FROM public.api_audit_logs
      WHERE tenant_id = ${T} AND action = 'candidate_set_diversity_self_id'`;
    assert.ok(api.length > 0);
    for (const r of api)
      assert.ok(!/pc26_yes|pc26_no/.test(JSON.stringify(r)), "api audit redacted");
  });

  it("9. apply-form writes are fill-only: no overwrite, no withdraw of an existing answer", async () => {
    const before = await slate();
    const res1 = await applySelfIdSubmission(poolDb, {
      tenantId: T,
      personId: P[0]!,
      submission: {
        disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
        answers: [{ categoryKey: "pc26cat", value: "pc26_no" }],
      },
      settings: SETTINGS,
      collectedVia: "apply_form",
    });
    assert.deepEqual(res1, { stored: 0, withdrawn: 0 }, "existing answer not overwritten");
    const res2 = await applySelfIdSubmission(poolDb, {
      tenantId: T,
      personId: P[0]!,
      submission: {
        disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
        answers: [{ categoryKey: "pc26cat", value: DIVERSITY_PREFER_NOT_TO_SAY }],
      },
      settings: SETTINGS,
      collectedVia: "apply_form",
    });
    assert.deepEqual(res2, { stored: 0, withdrawn: 0 }, "existing answer not withdrawn");
    assert.deepEqual(await slate(), before);
  });
});
