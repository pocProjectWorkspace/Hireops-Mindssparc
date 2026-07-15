/**
 * PARTNER-01 — partnerProcedure + partner-scoped read tests.
 *
 * Coverage:
 *   1. partnerProcedure rejects an unauthenticated caller (no userId)
 *      → UNAUTHORIZED.
 *   2. partnerProcedure rejects an identity with NO active partner_users
 *      row → FORBIDDEN. Covers both (a) a random unknown identity and
 *      (b) an INTERNAL user (has a tenant_user_membership, no partner row)
 *      — the exact "internal users are rejected" contract.
 *   3. partnerProcedure rejects an identity whose partner_users row is
 *      inactive → FORBIDDEN.
 *   4. partnerGetMe returns the resolved org + role + display identity.
 *   5. partnerListAssignedRequisitions returns ONLY the caller's partner
 *      org's active assignments — tenant-scoped AND org-scoped: a second
 *      partner org in the same tenant, and a whole second tenant, are both
 *      invisible. This exercises the RLS tenant isolation plus the explicit
 *      partnerOrgId predicate (the load-bearing org scoping).
 *
 * These tests drive the real appRouter via createCaller with a synthetic
 * HonoTRPCContext (userId set from a would-be JWT sub, ctx.sql = service-role
 * pool). partner_users.user_id has no auth.users FK yet (ships in a future
 * cross-schema migration), so partner identities use plain random UUIDs;
 * tenant_user_memberships.user_id DOES FK auth.users, so the one membership we
 * need borrows the signed-in test user's id.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

// PARTNER-01 synth namespace. Valid v4-format UUIDs (…-4000-8000-…) so they
// pass the procedures' strict z.string().uuid() OUTPUT validation; the `a02`
// marker keeps them distinct from the seed's a5xx/a6xx blocks. Synth tenants,
// torn down in afterAll.
const PT_TENANT = "00000000-0000-4000-8000-0000000a02a1";
const PT_TENANT_B = "00000000-0000-4000-8000-0000000a02a2";
const PT_ORG_1 = "00000000-0000-4000-8000-0000000a02b1";
const PT_ORG_2 = "00000000-0000-4000-8000-0000000a02b2"; // second org, SAME tenant
const PT_ORG_B = "00000000-0000-4000-8000-0000000a02b3"; // org in the second tenant
const PT_BU = "00000000-0000-4000-8000-0000000a02c1";
const PT_MEMBERSHIP = "00000000-0000-4000-8000-0000000a02c2";
const PT_POSITION = "00000000-0000-4000-8000-0000000a02c3";
const PT_JD = "00000000-0000-4000-8000-0000000a02c4";
const PT_REQ_1 = "00000000-0000-4000-8000-0000000a02d1";
const PT_REQ_2 = "00000000-0000-4000-8000-0000000a02d2";
const PT_REQ_ORG2 = "00000000-0000-4000-8000-0000000a02d3"; // req assigned to ORG_2
const PT_PARTNER_USER_1 = "00000000-0000-4000-8000-0000000a02e1";

// Partner auth identities (no auth.users FK — random uuids are fine).
const PARTNER_AUTH_1 = randomUUID(); // active partner_admin in ORG_1
const PARTNER_AUTH_INACTIVE = randomUUID(); // partner_users row but active=false
const UNKNOWN_AUTH = randomUUID(); // no partner_users row at all

const log = createLogger({ level: "error" });

let testUserId: string;

async function getTestUserId(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return decodeJwt(data.session.access_token).sub as string;
}

function makeCaller(userId: string | null) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: userId ? { sub: userId } : null,
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  for (const t of [PT_TENANT, PT_TENANT_B]) {
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t} AND entity_type IN ('partner_orgs','partner_users','partner_assignments','requisitions','positions','jd_versions')`;
    await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.positions WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${t}`;
  }
}

describe("PARTNER-01 partnerProcedure + partner reads", () => {
  beforeAll(async () => {
    testUserId = await getTestUserId();
    await cleanup();

    // Two synth tenants.
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PT_TENANT}, 'synth-partner-auth', 'Partner-Auth Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PT_TENANT_B}, 'synth-partner-auth-b', 'Partner-Auth-B Synth', 'ap-northeast-1', 'active')`;

    // FK chain in PT_TENANT for requisitions.
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PT_BU}, ${PT_TENANT}, 'PT BU', 'pt-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PT_MEMBERSHIP}, ${PT_TENANT}, ${testUserId}, ARRAY['recruiter']::tenant_role[], 'active', ${PT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PT_POSITION}, ${PT_TENANT}, ${PT_BU}, 'Synth Engineer', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PT_JD}, ${PT_TENANT}, ${PT_POSITION}, 1, '# JD', 'approved')`;
    for (const rq of [PT_REQ_1, PT_REQ_2, PT_REQ_ORG2]) {
      await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${rq}, ${PT_TENANT}, ${PT_POSITION}, ${PT_JD}, ${PT_MEMBERSHIP}, ${PT_MEMBERSHIP}, 'posted', true)`;
    }

    // Partner orgs: ORG_1 + ORG_2 in PT_TENANT, ORG_B in PT_TENANT_B.
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_1}, ${PT_TENANT}, 'TalentBridge Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_2}, ${PT_TENANT}, 'Rival Partners', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_B}, ${PT_TENANT_B}, 'Other-Tenant Partners', 'empanelled', true)`;

    // Partner users: active admin in ORG_1; an inactive one in ORG_1.
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PT_PARTNER_USER_1}, ${PT_TENANT}, ${PT_ORG_1}, ${PARTNER_AUTH_1}, 'Asha Synth', 'asha@talentbridge.example', 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${randomUUID()}, ${PT_TENANT}, ${PT_ORG_1}, ${PARTNER_AUTH_INACTIVE}, 'Ex Partner', 'ex@talentbridge.example', 'partner_user', false)`;

    // Assignments: ORG_1 → REQ_1 + REQ_2 (2 active), ORG_2 → REQ_ORG2.
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PT_TENANT}, ${PT_ORG_1}, ${PT_REQ_1}, ${PT_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PT_TENANT}, ${PT_ORG_1}, ${PT_REQ_2}, ${PT_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PT_TENANT}, ${PT_ORG_2}, ${PT_REQ_ORG2}, ${PT_MEMBERSHIP}, 'active')`;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  async function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
    let thrown: unknown;
    try {
      await fn();
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof TRPCError, `${label}: expected a TRPCError, got ${String(thrown)}`);
    assert.equal((thrown as TRPCError).code, code, `${label}: wrong code`);
  }

  it("Test 1: unauthenticated caller → UNAUTHORIZED", async () => {
    await expectCode(() => makeCaller(null).partnerGetMe(), "UNAUTHORIZED", "no userId");
  });

  it("Test 2: unknown identity (no partner_users row) → FORBIDDEN", async () => {
    await expectCode(() => makeCaller(UNKNOWN_AUTH).partnerGetMe(), "FORBIDDEN", "unknown user");
  });

  it("Test 2b: internal user (membership, no partner row) → FORBIDDEN", async () => {
    // testUserId has a tenant_user_membership in PT_TENANT but no partner_users
    // row — the exact shape of an internal recruiter. Must be rejected.
    await expectCode(() => makeCaller(testUserId).partnerGetMe(), "FORBIDDEN", "internal user");
  });

  it("Test 3: inactive partner_users row → FORBIDDEN", async () => {
    await expectCode(
      () => makeCaller(PARTNER_AUTH_INACTIVE).partnerGetMe(),
      "FORBIDDEN",
      "inactive partner",
    );
  });

  it("Test 4: partnerGetMe returns the resolved org + role + identity", async () => {
    const me = await makeCaller(PARTNER_AUTH_1).partnerGetMe();
    assert.equal(me.partnerOrgId, PT_ORG_1);
    assert.equal(me.tenantId, PT_TENANT);
    assert.equal(me.orgName, "TalentBridge Synth");
    assert.equal(me.role, "partner_admin");
    assert.equal(me.displayName, "Asha Synth");
  });

  it("Test 5: partnerListAssignedRequisitions is tenant- AND org-scoped", async () => {
    const res = await makeCaller(PARTNER_AUTH_1).partnerListAssignedRequisitions();
    const reqIds = res.items.map((r) => r.requisitionId).sort();
    assert.equal(res.items.length, 2, "exactly ORG_1's 2 active assignments");
    assert.deepEqual(reqIds, [PT_REQ_1, PT_REQ_2].sort(), "only ORG_1's reqs");
    // ORG_2's req (same tenant, different org) must NOT leak — proves the
    // explicit partnerOrgId predicate, since RLS alone wouldn't exclude it.
    assert.ok(!reqIds.includes(PT_REQ_ORG2), "ORG_2 assignment must not leak");
    assert.equal(res.capped, false);
    // Every row carries the columns the dashboard needs.
    for (const r of res.items) {
      assert.ok(typeof r.title === "string" && r.title.length > 0, "title present");
      assert.ok(typeof r.assignedAt === "string", "assignedAt present");
    }
  });

  it("Test 6: partnerListMySubmissions is empty for a fresh org (honest empty)", async () => {
    const res = await makeCaller(PARTNER_AUTH_1).partnerListMySubmissions();
    assert.equal(res.items.length, 0, "no seeded ownership claims → empty submissions");
    assert.equal(res.capped, false);
  });
});
