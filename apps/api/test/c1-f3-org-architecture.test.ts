/**
 * C1-F3 — organisation + job architecture + tenant lookups (migration 0133).
 *
 *   Test 1: role gates — pickers (recruiter / hiring_manager / hr_head / admin)
 *           read active rows; includeInactive + listTenantLookups are admin +
 *           hr_head; every write is admin-only (hr_head, recruiter FORBIDDEN);
 *           panel_member can't read.
 *   Test 2: CRUD — entity, location (+ entity), BU ↔ entity, functions,
 *           levels, profile with a level range; duplicate / foreign ids /
 *           inverted range → BAD_REQUEST; deactivated rows leave the picker
 *           read but stay in includeInactive; audit rows written.
 *   Test 3: lookups — platform defaults with no rows; override, add, reset;
 *           a tenant-only value can't be reset; the picker read reflects it.
 *   Test 4: job profile pre-fill on createRequisitionDraft — profile alone
 *           fills function + lowest level (and the free-text fallbacks); a
 *           level outside the range, an unknown lookup key, an inactive
 *           location → BAD_REQUEST; getRequisitionDetail returns the labels.
 *   Test 5: comp band scoping read — listCompBands({ scope }) returns the
 *           applicable bands most-specific first; midpoint outside range and a
 *           foreign scope id are rejected.
 *   Test 6: PC-17 renege reasons — loadRenegeReasons falls back to the
 *           pre-joining setting list with no lookup rows; lookup rows override.
 *
 * Fully synthetic tenant (namespace c1f3); cleans up after itself. Harness =
 * the real appRouter via createCaller (no network auth). NEEDS migration 0133
 * — run against a database that has it (validated on a throwaway local
 * Postgres with TEST_DATABASE_URL; do not point at a DB without 0133).
 * Requires the FK user test-fnd15b@hireops-dev.local (`pnpm db:seed:test-users`);
 * on a database without it (a local throwaway) the test creates the auth row.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { PLATFORM_RENEGE_REASONS } from "@hireops/api-types";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { loadRenegeReasons } from "../src/lib/tenant-lookups";

const T = "00000000-0000-4000-8000-00000c1f3a01";
const OTHER_T = "00000000-0000-4000-8000-00000c1f3b01";
const BU = "00000000-0000-4000-8000-00000c1f3a02";
const MEMBERSHIP = "00000000-0000-4000-8000-00000c1f3a03";
const FOREIGN_LEVEL = "00000000-0000-4000-8000-00000c1f3b02";
const TENANT_SLUG = "synth-c1f3-org-arch";
const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let USER_ID: string;
let createdAuthUser = false;

const log = createLogger({ level: "error" });

function caller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: T,
    userId: USER_ID,
    roles,
    claims: { sub: USER_ID, tid: T, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-c1f3-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function expectCode(p: Promise<unknown>, code: TRPCError["code"], what: string) {
  try {
    await p;
  } catch (err) {
    expect(err instanceof TRPCError, `${what}: not a TRPCError: ${String(err)}`).toBe(true);
    expect((err as TRPCError).code, `${what}: ${(err as Error).message}`).toBe(code);
    return (err as TRPCError).message;
  }
  throw new Error(`${what}: expected ${code}, but the call succeeded`);
}

async function auditCount(action: string): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const [a] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.api_audit_logs WHERE tenant_id = ${T} AND action = ${action}
    `;
    if (Number(a?.n) >= 1) return Number(a?.n);
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

async function cleanup(): Promise<void> {
  for (const t of [T, OTHER_T]) {
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.requisition_state_transitions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.comp_bands WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.job_profiles WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.job_levels WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.job_functions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenant_lookups WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${t}`;
    await poolSql`UPDATE public.business_units SET legal_entity_id = NULL WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.locations WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.legal_entities WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${t}`;
  }
}

const admin = () => caller(["admin"]);

describe("C1-F3 organisation + job architecture + lookups", () => {
  beforeAll(async () => {
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (user) {
      USER_ID = user.id;
    } else {
      // Throwaway local database only (no Supabase auth there).
      USER_ID = randomUUID();
      await poolSql`INSERT INTO auth.users (id, email) VALUES (${USER_ID}, ${TEST_USER_EMAIL_FOR_FK})`;
      createdAuthUser = true;
    }
    await cleanup();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${T}, ${TENANT_SLUG}, 'C1F3 Synth', 'ap-south-1', 'active')`;
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${OTHER_T}, ${TENANT_SLUG + "-other"}, 'C1F3 Other', 'ap-south-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, 'C1F3 Finance Ops', 'c1f3-finance-ops')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${MEMBERSHIP}, ${T}, ${USER_ID}, ARRAY['admin','hiring_manager']::tenant_role[], 'active', ${BU})`;
    await poolSql`INSERT INTO public.job_levels (id, tenant_id, key, label, rank) VALUES (${FOREIGN_LEVEL}, ${OTHER_T}, 'X1', 'Other tenant level', 1)`;
  });

  afterAll(async () => {
    await cleanup();
    if (createdAuthUser) await poolSql`DELETE FROM auth.users WHERE id = ${USER_ID}`;
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: role gates", async () => {
    for (const role of ["recruiter", "hiring_manager", "hr_head", "admin"]) {
      const arch = await caller([role]).getOrgAndJobArchitecture({});
      expect(arch.lookups.employmentType.length).toBeGreaterThan(0);
    }
    await expectCode(
      caller(["panel_member"]).getOrgAndJobArchitecture({}),
      "FORBIDDEN",
      "panel read",
    );
    for (const role of ["recruiter", "hiring_manager"]) {
      await expectCode(
        caller([role]).getOrgAndJobArchitecture({ includeInactive: true }),
        "FORBIDDEN",
        `${role} includeInactive`,
      );
      await expectCode(caller([role]).listTenantLookups({}), "FORBIDDEN", `${role} lookups`);
    }
    await caller(["hr_head"]).getOrgAndJobArchitecture({ includeInactive: true });
    await caller(["hr_head"]).listTenantLookups({});
    for (const role of ["hr_head", "recruiter", "hiring_manager"]) {
      const c = caller([role]);
      await expectCode(
        c.createLegalEntity({ name: "X", countryCode: "IN" }),
        "FORBIDDEN",
        `${role} entity`,
      );
      await expectCode(
        c.createLocation({ name: "X", countryCode: "IN" }),
        "FORBIDDEN",
        `${role} location`,
      );
      await expectCode(
        c.createJobFunction({ key: "x", label: "X" }),
        "FORBIDDEN",
        `${role} function`,
      );
      await expectCode(
        c.createJobLevel({ key: "X", label: "X", rank: 1 }),
        "FORBIDDEN",
        `${role} level`,
      );
      await expectCode(c.createJobProfile({ title: "XX" }), "FORBIDDEN", `${role} profile`);
      await expectCode(
        c.upsertTenantLookup({ kind: "asset_type", key: "dock", label: "Dock" }),
        "FORBIDDEN",
        `${role} lookup`,
      );
      await expectCode(
        c.setBusinessUnitLegalEntity({ businessUnitId: BU, legalEntityId: null }),
        "FORBIDDEN",
        `${role} bu entity`,
      );
    }
  });

  let entityId: string;
  let locationId: string;
  let inactiveLocationId: string;
  let fnFinance: string;
  let lv10: string;
  let lv12: string;
  let lv14: string;
  let profileId: string;

  it("Test 2: CRUD + validation + audit", async () => {
    const a = admin();
    entityId = (
      await a.createLegalEntity({ name: "Acme Services India Pvt Ltd", countryCode: "in" })
    ).row.id;
    await expectCode(
      a.createLegalEntity({ name: "Acme Services India Pvt Ltd", countryCode: "IN" }),
      "BAD_REQUEST",
      "duplicate entity",
    );
    const loc = await a.createLocation({
      name: "Hyderabad",
      city: "Hyderabad",
      region: "Telangana",
      countryCode: "IN",
      legalEntityId: entityId,
      timezone: "Asia/Kolkata",
    });
    locationId = loc.row.id;
    expect(loc.row.countryCode).toBe("IN");
    inactiveLocationId = (await a.createLocation({ name: "Pune", city: "Pune", countryCode: "IN" }))
      .row.id;
    await a.updateLocation({
      id: inactiveLocationId,
      name: "Pune",
      city: "Pune",
      countryCode: "IN",
      isActive: false,
    });
    await expectCode(
      a.createLocation({ name: "Bad", countryCode: "IN", legalEntityId: randomUUID() }),
      "BAD_REQUEST",
      "foreign entity",
    );
    const bu = await a.setBusinessUnitLegalEntity({ businessUnitId: BU, legalEntityId: entityId });
    expect(bu.row.legalEntityId).toBe(entityId);

    fnFinance = (await a.createJobFunction({ key: "finance", label: "Finance", sortOrder: 10 })).row
      .id;
    await expectCode(
      a.createJobFunction({ key: "finance", label: "Dup" }),
      "BAD_REQUEST",
      "duplicate function key",
    );
    lv10 = (await a.createJobLevel({ key: "IN10", label: "Band 10", rank: 10 })).row.id;
    lv12 = (await a.createJobLevel({ key: "IN12", label: "Band 12", rank: 12 })).row.id;
    lv14 = (await a.createJobLevel({ key: "IN14", label: "Band 14", rank: 14 })).row.id;

    await expectCode(
      a.createJobProfile({ title: "Inverted", jobLevelMinId: lv14, jobLevelMaxId: lv10 }),
      "BAD_REQUEST",
      "inverted range",
    );
    await expectCode(
      a.createJobProfile({ title: "Foreign", jobLevelMinId: FOREIGN_LEVEL }),
      "BAD_REQUEST",
      "foreign level",
    );
    const prof = await a.createJobProfile({
      title: "Accounts Payable Analyst",
      jobFunctionId: fnFinance,
      jobLevelMinId: lv10,
      jobLevelMaxId: lv12,
      competencies: [
        { key: "reconciliation", label: "Reconciliation" },
        { key: "vendor_management", label: "Vendor management" },
      ],
      canonicalMarketTitle: "Accounts Payable Specialist",
    });
    profileId = prof.row.id;
    expect(prof.row.competencies).toHaveLength(2);

    // Deactivate a level: gone from the picker read, kept for the admin read.
    await a.updateJobLevel({ id: lv14, label: "Band 14", rank: 14, isActive: false });
    const picker = await caller(["recruiter"]).getOrgAndJobArchitecture({});
    expect(picker.jobLevels.map((l) => l.key)).toEqual(["IN10", "IN12"]);
    expect(picker.locations.map((l) => l.name)).toEqual(["Hyderabad"]);
    expect(picker.businessUnits.find((b) => b.id === BU)?.legalEntityId).toBe(entityId);
    const full = await a.getOrgAndJobArchitecture({ includeInactive: true });
    expect(full.jobLevels.map((l) => l.key)).toEqual(["IN10", "IN12", "IN14"]);
    expect(full.locations).toHaveLength(2);
    // Another tenant's rows never leak.
    expect(full.jobLevels.some((l) => l.id === FOREIGN_LEVEL)).toBe(false);

    expect(await auditCount("create_job_profile")).toBeGreaterThanOrEqual(1);
    expect(await auditCount("create_location")).toBeGreaterThanOrEqual(1);
    const [trig] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.audit_logs
      WHERE tenant_id = ${T} AND entity_type IN ('job_profiles', 'locations', 'legal_entities')
    `;
    expect(Number(trig?.n)).toBeGreaterThanOrEqual(3);
  });

  it("Test 3: lookups — defaults, override, add, reset", async () => {
    const a = admin();
    const before = await a.listTenantLookups({ kind: "requisition_type" });
    expect(before.kinds[0]?.entries.map((e) => [e.key, e.source])).toEqual([
      ["new", "platform"],
      ["replacement", "platform"],
      ["investment", "platform"],
    ]);
    await a.upsertTenantLookup({
      kind: "requisition_type",
      key: "replacement",
      label: "Backfill",
      sortOrder: 20,
    });
    const added = await a.upsertTenantLookup({
      kind: "requisition_type",
      key: "leave_cover",
      label: "Leave cover",
      sortOrder: 25,
    });
    expect(added.kind.entries.map((e) => [e.key, e.label, e.source])).toEqual([
      ["new", "New headcount", "platform"],
      ["replacement", "Backfill", "override"],
      ["leave_cover", "Leave cover", "tenant"],
      ["investment", "Investment / growth", "platform"],
    ]);
    await a.upsertTenantLookup({
      kind: "requisition_type",
      key: "investment",
      label: "Investment",
      sortOrder: 30,
      isActive: false,
    });
    const picker = await caller(["hiring_manager"]).getOrgAndJobArchitecture({});
    expect(picker.lookups.requisitionType.map((e) => e.key)).toEqual([
      "new",
      "replacement",
      "leave_cover",
    ]);

    const reset = await a.resetTenantLookup({ kind: "requisition_type", key: "replacement" });
    expect(reset.kind.entries.find((e) => e.key === "replacement")?.label).toBe("Replacement");
    await expectCode(
      a.resetTenantLookup({ kind: "requisition_type", key: "leave_cover" }),
      "BAD_REQUEST",
      "reset tenant-only",
    );
    expect(await auditCount("upsert_tenant_lookup")).toBeGreaterThanOrEqual(1);
  });

  it("Test 4: job profile pre-fill on createRequisitionDraft", async () => {
    const a = caller(["admin", "hiring_manager"]);
    const { requisitionId } = await a.createRequisitionDraft({
      title: "Accounts Payable Analyst",
      businessUnitId: BU,
      locationType: "onsite",
      numberOfOpenings: 1,
      jobProfileId: profileId,
      locationId,
      employmentTypeKey: "full_time",
      requisitionTypeKey: "leave_cover",
    });
    const [req] = await poolSql<
      {
        job_profile_id: string | null;
        job_function_id: string | null;
        job_level_id: string | null;
        location_id: string | null;
        employment_type_key: string | null;
        requisition_type_key: string | null;
        level: string | null;
        function: string | null;
        primary_location: string | null;
        pos_level_id: string | null;
      }[]
    >`
      SELECT r.job_profile_id, r.job_function_id, r.job_level_id, r.location_id,
             r.employment_type_key, r.requisition_type_key,
             p.level, p.function, p.primary_location, p.job_level_id AS pos_level_id
      FROM public.requisitions r JOIN public.positions p ON p.id = r.position_id
      WHERE r.id = ${requisitionId}
    `;
    expect(req).toMatchObject({
      job_profile_id: profileId,
      job_function_id: fnFinance,
      job_level_id: lv10,
      pos_level_id: lv10,
      location_id: locationId,
      employment_type_key: "full_time",
      requisition_type_key: "leave_cover",
      level: "Band 10",
      function: "Finance",
      primary_location: "Hyderabad",
    });

    const detail = await a.getRequisitionDetail({ requisitionId });
    expect(detail).toMatchObject({
      jobProfileTitle: "Accounts Payable Analyst",
      jobFunctionLabel: "Finance",
      jobLevelLabel: "Band 10",
      locationName: "Hyderabad",
      employmentTypeLabel: "Full-time (permanent)",
      requisitionTypeLabel: "Leave cover",
      seniority: "Band 10",
      primaryLocation: "Hyderabad",
    });

    const base = {
      businessUnitId: BU,
      locationType: "onsite" as const,
      numberOfOpenings: 1,
      jobProfileId: profileId,
    };
    await expectCode(
      a.createRequisitionDraft({ ...base, title: "Out of range", jobLevelId: lv14 }),
      "BAD_REQUEST",
      "inactive / out-of-range level",
    );
    // An in-range explicit level wins over the pre-fill.
    const ok = await a.createRequisitionDraft({
      ...base,
      title: "AP Analyst II",
      jobLevelId: lv12,
    });
    const [r2] = await poolSql<{ job_level_id: string }[]>`
      SELECT job_level_id FROM public.requisitions WHERE id = ${ok.requisitionId}
    `;
    expect(r2?.job_level_id).toBe(lv12);
    await expectCode(
      a.createRequisitionDraft({ ...base, title: "Bad emp", employmentTypeKey: "gig" }),
      "BAD_REQUEST",
      "unknown employment type",
    );
    await expectCode(
      a.createRequisitionDraft({ ...base, title: "Inactive rt", requisitionTypeKey: "investment" }),
      "BAD_REQUEST",
      "inactive requisition type",
    );
    await expectCode(
      a.createRequisitionDraft({ ...base, title: "Inactive loc", locationId: inactiveLocationId }),
      "BAD_REQUEST",
      "inactive location",
    );
    // No structured fields at all → pre-0133 behaviour (all null, free text kept).
    const plain = await a.createRequisitionDraft({
      title: "Plain draft",
      businessUnitId: BU,
      locationType: "remote",
      primaryLocation: "Anywhere",
      seniority: "Senior",
      numberOfOpenings: 1,
    });
    const [r3] = await poolSql<
      { job_level_id: string | null; level: string | null; primary_location: string | null }[]
    >`
      SELECT r.job_level_id, p.level, p.primary_location
      FROM public.requisitions r JOIN public.positions p ON p.id = r.position_id
      WHERE r.id = ${plain.requisitionId}
    `;
    expect(r3).toEqual({ job_level_id: null, level: "Senior", primary_location: "Anywhere" });
  });

  it("Test 5: comp band scoping read", async () => {
    const a = admin();
    const mk = (name: string, extra: Record<string, unknown>) =>
      a.createCompBand({ name, currency: "INR", minMajor: 100, maxMajor: 300, ...extra });
    await mk("C1F3 any", {});
    await mk("C1F3 level", { jobLevelId: lv10, midpointMajor: 200 });
    await mk("C1F3 level+loc", { jobLevelId: lv10, locationId });
    await mk("C1F3 level+fn+loc", { jobLevelId: lv10, jobFunctionId: fnFinance, locationId });
    await mk("C1F3 other level", { jobLevelId: lv12 });

    const scoped = await caller(["recruiter"]).listCompBands({
      scope: { jobLevelId: lv10, jobFunctionId: fnFinance, locationId },
    });
    expect(scoped.rows.map((r) => r.name)).toEqual([
      "C1F3 level+fn+loc",
      "C1F3 level+loc",
      "C1F3 level",
      "C1F3 any",
    ]);
    expect(scoped.rows.find((r) => r.name === "C1F3 level")?.midpointMajor).toBe(200);
    const levelOnly = await caller(["recruiter"]).listCompBands({ scope: { jobLevelId: lv12 } });
    expect(levelOnly.rows.map((r) => r.name)).toEqual(["C1F3 other level", "C1F3 any"]);
    // Unscoped list keeps every band, ordered by name.
    const all = await caller(["recruiter"]).listCompBands({});
    expect(all.rows).toHaveLength(5);

    await expectCode(
      mk("C1F3 bad mid", { midpointMajor: 400 }),
      "BAD_REQUEST",
      "midpoint outside range",
    );
    await expectCode(
      mk("C1F3 foreign", { jobLevelId: FOREIGN_LEVEL }),
      "BAD_REQUEST",
      "foreign scope",
    );
  });

  it("Test 6: renege reasons read the lookup with the setting as fallback", async () => {
    const settings = [
      { code: "counter_offer", label: "Took a counter-offer" },
      { code: "other", label: "Other" },
    ];
    expect(await loadRenegeReasons(poolSql, T, settings)).toEqual(settings);
    expect(await loadRenegeReasons(poolSql, T, PLATFORM_RENEGE_REASONS)).toEqual(
      PLATFORM_RENEGE_REASONS,
    );
    await admin().upsertTenantLookup({
      kind: "renege_reason",
      key: "competing_gcc",
      label: "Joined a competing GCC",
      sortOrder: 15,
    });
    await admin().upsertTenantLookup({
      kind: "renege_reason",
      key: "other",
      label: "Other",
      sortOrder: 20,
      isActive: false,
    });
    expect(await loadRenegeReasons(poolSql, T, settings)).toEqual([
      { code: "counter_offer", label: "Took a counter-offer" },
      { code: "competing_gcc", label: "Joined a competing GCC" },
    ]);
    // The Lists page resolves renege reasons over the tenant's pre-joining
    // setting (the runtime fallback), not the bare platform list.
    await poolSql`
      UPDATE public.tenants
      SET settings = jsonb_build_object('preJoiningEngagement', ${JSON.stringify({ renegeReasons: settings })}::jsonb)
      WHERE id = ${T}
    `;
    const view = await admin().listTenantLookups({ kind: "renege_reason" });
    expect(view.kinds[0]?.entries.map((e) => [e.key, e.label, e.source, e.isActive])).toEqual([
      ["counter_offer", "Took a counter-offer", "platform", true],
      ["competing_gcc", "Joined a competing GCC", "tenant", true],
      ["other", "Other", "override", false],
    ]);
  });
});
