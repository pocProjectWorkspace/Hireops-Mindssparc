/**
 * P0.1A — internal partner administration (admin / hr_ops).
 *
 * The INTERNAL-STAFF counterpart to partner-auth.test.ts / partner-submission
 * .test.ts: those drive partnerProcedure with a partner identity, this one
 * drives the eight protectedProcedure procedures internal staff use to create
 * partner orgs, invite partner users, and open/close requisitions to a partner.
 *
 * Harness: the real appRouter via createCaller with a synthetic INTERNAL
 * HonoTRPCContext — tenantId + userId + roles + claims{sub,tid,tenant_slug,
 * roles}. protectedProcedure opens withTenantContext from those claims, so RLS
 * (current_tenant_id()) and the DB-AUDIT trigger behave exactly as they do
 * behind a real JWT. The role gate reads ctx.roles (which in production comes
 * from the JWT's roles claim), so one membership row plus per-caller ctx.roles
 * is the faithful way to exercise admin / hr_ops / recruiter.
 * tenant_user_memberships.user_id FKs auth.users, so the membership borrows the
 * shared test user's id; partner_users.user_id has no such FK, so the partner
 * identity is a plain random UUID (same reasoning as partner-auth.test.ts).
 *
 * Coverage:
 *   1. Role gating — recruiter is FORBIDDEN on listPartnerOrgs and
 *      createPartnerOrg; admin and hr_ops are both allowed.
 *   2. createPartnerOrg → listPartnerOrgs shows the org with userCount /
 *      activeAssignmentCount / activeClaimCount all 0, email lower-cased and
 *      country upper-cased.
 *   3. invitePartnerUser — acceptUrl carries the RAW token, the row stores only
 *      its sha256, expiresAt ≈ now + PARTNER_INVITE_EXPIRY_DAYS, and the
 *      invitation email is enqueued.
 *   4. CONFLICT on a second live invitation for the same email+org, and on an
 *      email that is already an ACTIVE partner_users row in the org.
 *   5. revokePartnerInvitation → the invitation leaves getPartnerOrg's
 *      pendingInvitations (row kept, revoked_at stamped).
 *   6. assignRequisitionToPartner → visible in getPartnerOrg's assignments AND
 *      in the partner's own partnerListAssignedRequisitions; a duplicate active
 *      assignment CONFLICTs; endPartnerAssignment removes it from the partner
 *      list while keeping it (status ended) in the internal history.
 *   7. Tenant isolation — getPartnerOrg with another tenant's org → NOT_FOUND.
 *
 * Tests run in file order and share fixtures deliberately (same convention as
 * partner-submission.test.ts): test 2 creates the org the later tests act on,
 * and the partner_users row inserted in test 4 (as the "already an active
 * user" CONFLICT fixture) doubles as the partner identity test 6 signs in as.
 * Every assertion is scoped to this file's synthetic tenants, which are
 * created and torn down here — no global counts.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import {
  PARTNER_INVITE_EXPIRY_DAYS,
  hashPartnerInviteToken,
  partnerPortalBaseUrl,
} from "../src/lib/partner-admin";

// a04 synth namespace (partner-auth owns a02, partner-submission a03).
// Valid v4-format UUIDs so they satisfy the procedures' z.string().uuid()
// OUTPUT validation.
const PA_TENANT = "00000000-0000-4000-8000-0000000a04a1";
const PA_TENANT_B = "00000000-0000-4000-8000-0000000a04a2";
const PA_BU = "00000000-0000-4000-8000-0000000a04c1";
const PA_MEMBERSHIP = "00000000-0000-4000-8000-0000000a04c2";
const PA_POSITION = "00000000-0000-4000-8000-0000000a04c3";
const PA_JD = "00000000-0000-4000-8000-0000000a04c4";
const PA_REQ_1 = "00000000-0000-4000-8000-0000000a04d1";
const PA_REQ_2 = "00000000-0000-4000-8000-0000000a04d2";
const PA_ORG_B = "00000000-0000-4000-8000-0000000a04b1"; // org in the OTHER tenant
const PA_PARTNER_USER = "00000000-0000-4000-8000-0000000a04e1";

const TENANT_SLUG = "synth-partner-admin";
const TENANT_DISPLAY_NAME = "Partner-Admin Synth";

// The partner-portal identity used in test 6. No auth.users FK on
// partner_users.user_id, so a random uuid is a legitimate identity.
const PARTNER_AUTH = randomUUID();

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

// Mixed case on purpose — the lib lower-cases emails on the way in.
const INVITE_EMAIL_RAW = "Nisha.Rao@Northstar.example";
const INVITE_EMAIL = "nisha.rao@northstar.example";
const EXISTING_PARTNER_EMAIL = "asha@northstar.example";

const log = createLogger({ level: "error" });

/** Internal-staff caller: the ctx protectedProcedure would build from a JWT. */
function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: PA_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: {
      sub: TEST_USER_FOR_FK,
      tid: PA_TENANT,
      tenant_slug: TENANT_SLUG,
      roles,
    },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-admin-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** Partner-portal caller: partnerProcedure resolves everything from userId. */
function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-admin-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  for (const t of [PA_TENANT, PA_TENANT_B]) {
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.partner_invitations WHERE tenant_id = ${t}`;
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

describe("P0.1A internal partner administration", () => {
  // Created by the procedures under test, so they can't be constants.
  let adminOrgId: string;
  let hrOpsOrgId: string;
  let invitationId: string;
  let assignmentId: string;

  beforeAll(async () => {
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P0.1A prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PA_TENANT}, ${TENANT_SLUG}, ${TENANT_DISPLAY_NAME}, 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PA_TENANT_B}, 'synth-partner-admin-b', 'Partner-Admin-B Synth', 'ap-northeast-1', 'active')`;

    // FK chain in PA_TENANT so requisitions (and their titles) exist.
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PA_BU}, ${PA_TENANT}, 'PA BU', 'pa-bu')`;
    // One membership, three personas: the gate reads ctx.roles (the JWT roles
    // claim), and this row's roles array is what such a JWT would carry.
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PA_MEMBERSHIP}, ${PA_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${PA_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PA_POSITION}, ${PA_TENANT}, ${PA_BU}, 'Synth Platform Engineer', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PA_JD}, ${PA_TENANT}, ${PA_POSITION}, 1, '# JD', 'approved')`;
    for (const rq of [PA_REQ_1, PA_REQ_2]) {
      await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${rq}, ${PA_TENANT}, ${PA_POSITION}, ${PA_JD}, ${PA_MEMBERSHIP}, ${PA_MEMBERSHIP}, 'posted', true)`;
    }

    // The other tenant's org — the cross-tenant probe target for test 7.
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PA_ORG_B}, ${PA_TENANT_B}, 'Other-Tenant Partners', 'empanelled', true)`;
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

  it("Test 1: recruiter is FORBIDDEN; admin and hr_ops are allowed", async () => {
    const recruiter = makeInternalCaller(["recruiter"]);
    await expectCode(() => recruiter.listPartnerOrgs(), "FORBIDDEN", "recruiter listPartnerOrgs");
    await expectCode(
      () =>
        recruiter.createPartnerOrg({
          name: "Recruiter Should Not Create",
          tier: "ad_hoc",
          primaryContactEmail: "nope@example.com",
        }),
      "FORBIDDEN",
      "recruiter createPartnerOrg",
    );
    // Nothing was created by the rejected attempt.
    const [orgCountRow] = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.partner_orgs WHERE tenant_id = ${PA_TENANT}
    `;
    assert.equal(orgCountRow?.count, "0", "FORBIDDEN create must not insert a partner org");

    // Both privileged personas can read (empty is the honest answer here).
    const asAdmin = await makeInternalCaller(["admin"]).listPartnerOrgs();
    assert.deepEqual(asAdmin.items, [], "admin can read; tenant has no orgs yet");
    const asHrOps = await makeInternalCaller(["hr_ops"]).listPartnerOrgs();
    assert.deepEqual(asHrOps.items, [], "hr_ops can read too");
  });

  it("Test 2: createPartnerOrg (admin + hr_ops) → listPartnerOrgs with zero counts", async () => {
    const created = await makeInternalCaller(["admin"]).createPartnerOrg({
      name: "Northstar Staffing Synth",
      tier: "empanelled",
      primaryContactEmail: "Contact@Northstar.Example",
      primaryContactPhone: "+91 98000 12345",
      country: "in",
    });
    adminOrgId = created.partnerOrgId;

    // hr_ops must be able to create as well — it runs the vendor relationship.
    const createdByHrOps = await makeInternalCaller(["hr_ops"]).createPartnerOrg({
      name: "Bluebird Talent Synth",
      tier: "ad_hoc",
      primaryContactEmail: "ops@bluebird.example",
    });
    hrOpsOrgId = createdByHrOps.partnerOrgId;

    const list = await makeInternalCaller(["admin"]).listPartnerOrgs();
    // The tenant is this file's own, so its full contents are fixture-scoped.
    assert.equal(list.items.length, 2, "exactly the two orgs this test created");
    assert.deepEqual(
      list.items.map((o) => o.name),
      ["Bluebird Talent Synth", "Northstar Staffing Synth"],
      "alphabetical by name",
    );

    const org = list.items.find((o) => o.partnerOrgId === adminOrgId);
    assert.ok(org, "the admin-created org is in the list");
    assert.equal(org.tier, "empanelled");
    assert.equal(org.active, true, "new orgs are active");
    assert.ok(org.onboardedAt, "onboardedAt stamped at creation");
    assert.equal(org.primaryContactEmail, "contact@northstar.example", "email lower-cased");
    assert.equal(org.country, "IN", "country upper-cased");
    assert.equal(org.primaryContactPhone, "+91 98000 12345");
    assert.equal(org.userCount, 0, "no portal users yet");
    assert.equal(org.activeAssignmentCount, 0, "no assignments yet");
    assert.equal(org.activeClaimCount, 0, "no ownership claims yet");

    const detail = await makeInternalCaller(["hr_ops"]).getPartnerOrg({ partnerOrgId: hrOpsOrgId });
    assert.equal(detail.org.name, "Bluebird Talent Synth");
    assert.equal(detail.org.tier, "ad_hoc");
    assert.equal(detail.org.country, null, "country is optional");
    assert.deepEqual(detail.users, []);
    assert.deepEqual(detail.pendingInvitations, []);
    assert.deepEqual(detail.assignments, []);
  });

  it("Test 3: invitePartnerUser returns the raw-token link; only the hash is stored", async () => {
    const before = Date.now();
    const out = await makeInternalCaller(["hr_ops"]).invitePartnerUser({
      partnerOrgId: adminOrgId,
      email: INVITE_EMAIL_RAW,
      fullName: "Nisha Rao",
      role: "partner_user",
    });
    invitationId = out.invitationId;

    const prefix = `${partnerPortalBaseUrl()}/accept-invite/`;
    assert.ok(out.acceptUrl.startsWith(prefix), `acceptUrl shape: ${out.acceptUrl}`);
    const rawToken = out.acceptUrl.slice(prefix.length);
    assert.ok(rawToken.length >= 40, "32 random bytes base64url ≈ 43 chars");

    const [row] = await poolSql<
      {
        id: string;
        email: string;
        intended_role: string;
        token_hash: string;
        partner_org_id: string;
        created_by_membership_id: string | null;
        expires_at: Date;
        consumed_at: Date | null;
        revoked_at: Date | null;
      }[]
    >`
      SELECT id, email, intended_role::text AS intended_role, token_hash, partner_org_id,
             created_by_membership_id, expires_at, consumed_at, revoked_at
      FROM public.partner_invitations WHERE id = ${out.invitationId}
    `;
    assert.ok(row, "invitation row exists");
    assert.equal(row.partner_org_id, adminOrgId);
    assert.equal(row.email, INVITE_EMAIL, "email stored lower-cased");
    assert.equal(row.intended_role, "partner_user");
    assert.equal(row.created_by_membership_id, PA_MEMBERSHIP, "attributed to the inviting staffer");
    assert.equal(row.consumed_at, null);
    assert.equal(row.revoked_at, null);

    // The load-bearing assertion: the DB holds the sha256, never the raw token.
    assert.equal(row.token_hash, hashPartnerInviteToken(rawToken), "stored hash matches sha256");
    assert.notEqual(row.token_hash, rawToken, "raw token is NOT what is stored");
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, "token_hash is sha256 hex");
    const [leakedRow] = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.partner_invitations
      WHERE tenant_id = ${PA_TENANT} AND token_hash = ${rawToken}
    `;
    assert.equal(leakedRow?.count, "0", "no row stores the raw token in token_hash");

    // expiresAt ≈ now + PARTNER_INVITE_EXPIRY_DAYS (generous window: the whole
    // mutation, including the email enqueue, happens between the two clocks).
    const expectedMs = PARTNER_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    const actualMs = new Date(out.expiresAt).getTime() - before;
    assert.ok(
      Math.abs(actualMs - expectedMs) < 60_000,
      `expiresAt ≈ now + ${PARTNER_INVITE_EXPIRY_DAYS}d (off by ${actualMs - expectedMs}ms)`,
    );
    // poolSql returns timestamptz as a string — normalise both sides through Date.
    assert.equal(
      new Date(row.expires_at).toISOString(),
      new Date(out.expiresAt).toISOString(),
      "returned expiry is the persisted one",
    );

    // The invitation email is enqueued in the same tx, addressed to the invitee.
    const [mail] = await poolSql<
      { template_key: string; recipient_type: string; recipient_email: string; template_data: unknown }[]
    >`
      SELECT template_key, recipient_type, recipient_email, template_data
      FROM public.notification_outbox
      WHERE tenant_id = ${PA_TENANT} AND dedup_key = ${`partner_invitation:${out.invitationId}`}
    `;
    assert.ok(mail, "invitation email enqueued");
    assert.equal(mail.template_key, "partner.invitation");
    assert.equal(mail.recipient_type, "partner");
    assert.equal(mail.recipient_email, INVITE_EMAIL);
    const data = mail.template_data as Record<string, unknown>;
    assert.equal(data.acceptUrl, out.acceptUrl, "the email carries the same link");
    assert.equal(data.partnerOrgName, "Northstar Staffing Synth");
    assert.equal(data.companyName, TENANT_DISPLAY_NAME, "tenant display name in the copy");

    // And it shows up as a live invitation on the org detail.
    const detail = await makeInternalCaller(["admin"]).getPartnerOrg({ partnerOrgId: adminOrgId });
    assert.equal(detail.pendingInvitations.length, 1);
    assert.equal(detail.pendingInvitations[0]?.invitationId, out.invitationId);
    assert.equal(detail.pendingInvitations[0]?.email, INVITE_EMAIL);
    assert.equal(detail.pendingInvitations[0]?.intendedRole, "partner_user");
  });

  it("Test 4: CONFLICT on a duplicate live invitation and on an active partner user", async () => {
    const admin = makeInternalCaller(["admin"]);

    // (a) Same email + same org while the first invitation is still live.
    await expectCode(
      () =>
        admin.invitePartnerUser({
          partnerOrgId: adminOrgId,
          email: INVITE_EMAIL,
          fullName: "Nisha Rao",
          role: "partner_user",
        }),
      "CONFLICT",
      "duplicate live invitation",
    );
    const [inviteRow] = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.partner_invitations
      WHERE tenant_id = ${PA_TENANT} AND partner_org_id = ${adminOrgId} AND email = ${INVITE_EMAIL}
    `;
    assert.equal(inviteRow?.count, "1", "the rejected re-invite created no second row");

    // (b) An email that already belongs to an ACTIVE partner_users row. This
    // row is also the partner identity test 6 signs in as.
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PA_PARTNER_USER}, ${PA_TENANT}, ${adminOrgId}, ${PARTNER_AUTH}, 'Asha Synth', ${EXISTING_PARTNER_EMAIL}, 'partner_admin', true)`;
    await expectCode(
      () =>
        admin.invitePartnerUser({
          partnerOrgId: adminOrgId,
          email: EXISTING_PARTNER_EMAIL.toUpperCase(),
          fullName: "Asha Synth",
          role: "partner_user",
        }),
      "CONFLICT",
      "email is already an active partner user",
    );

    // The same email in a DIFFERENT org is fine — the guard is per-org.
    const otherOrgInvite = await admin.invitePartnerUser({
      partnerOrgId: hrOpsOrgId,
      email: EXISTING_PARTNER_EMAIL,
      fullName: "Asha Synth",
      role: "partner_user",
    });
    assert.ok(otherOrgInvite.invitationId, "invitation minted for the other org");

    // The new partner user now counts on the org summary.
    const list = await admin.listPartnerOrgs();
    const org = list.items.find((o) => o.partnerOrgId === adminOrgId);
    assert.equal(org?.userCount, 1, "the active partner user is counted");
  });

  it("Test 5: revokePartnerInvitation removes it from pendingInvitations", async () => {
    const admin = makeInternalCaller(["admin"]);
    const out = await admin.revokePartnerInvitation({ invitationId });
    assert.equal(out.invitationId, invitationId);
    assert.ok(out.revokedAt, "revokedAt stamped");

    const detail = await admin.getPartnerOrg({ partnerOrgId: adminOrgId });
    assert.ok(
      !detail.pendingInvitations.some((i) => i.invitationId === invitationId),
      "revoked invitation is no longer pending",
    );

    // The row is KEPT as the audit trail, with revoked_at set.
    const [row] = await poolSql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM public.partner_invitations WHERE id = ${invitationId}
    `;
    assert.ok(row?.revoked_at, "row retained with revoked_at stamped");

    // Revoking frees the email to be re-invited.
    const reissued = await admin.invitePartnerUser({
      partnerOrgId: adminOrgId,
      email: INVITE_EMAIL,
      fullName: "Nisha Rao",
      role: "partner_user",
    });
    assert.notEqual(reissued.invitationId, invitationId, "a fresh invitation row");
    await admin.revokePartnerInvitation({ invitationId: reissued.invitationId });
  });

  it("Test 6: assign → visible to the partner; end → gone from their list", async () => {
    const admin = makeInternalCaller(["admin"]);
    const partner = makePartnerCaller(PARTNER_AUTH);

    // Nothing assigned yet.
    const before = await partner.partnerListAssignedRequisitions();
    assert.equal(before.items.length, 0, "partner starts with no assigned reqs");

    const assigned = await admin.assignRequisitionToPartner({
      partnerOrgId: adminOrgId,
      requisitionId: PA_REQ_1,
    });
    assignmentId = assigned.assignmentId;

    // Internal view: the assignment, with the req title resolved.
    const detail = await admin.getPartnerOrg({ partnerOrgId: adminOrgId });
    const row = detail.assignments.find((a) => a.assignmentId === assignmentId);
    assert.ok(row, "assignment on the internal detail");
    assert.equal(row.requisitionId, PA_REQ_1);
    assert.equal(row.status, "active");
    assert.equal(row.title, "Synth Platform Engineer");
    assert.equal(row.endedAt, null);
    assert.equal(detail.org.activeAssignmentCount, 1, "counted on the summary");

    // Partner view: the same req, through partnerProcedure.
    const partnerList = await partner.partnerListAssignedRequisitions();
    assert.equal(partnerList.items.length, 1, "the partner sees exactly the assigned req");
    assert.equal(partnerList.items[0]?.requisitionId, PA_REQ_1);
    // PA_REQ_2 was never assigned — it must not appear.
    assert.ok(
      !partnerList.items.some((i) => i.requisitionId === PA_REQ_2),
      "unassigned req must not leak",
    );

    // Duplicate ACTIVE assignment → CONFLICT (and no second row).
    await expectCode(
      () => admin.assignRequisitionToPartner({ partnerOrgId: adminOrgId, requisitionId: PA_REQ_1 }),
      "CONFLICT",
      "duplicate active assignment",
    );
    const [assignmentRow] = await poolSql<{ count: string }[]>`
      SELECT count(*)::text FROM public.partner_assignments
      WHERE tenant_id = ${PA_TENANT} AND partner_org_id = ${adminOrgId} AND requisition_id = ${PA_REQ_1}
    `;
    assert.equal(assignmentRow?.count, "1", "the rejected re-assignment created no second row");

    // A requisition from outside the tenant (or a non-existent one) → NOT_FOUND.
    await expectCode(
      () =>
        admin.assignRequisitionToPartner({
          partnerOrgId: adminOrgId,
          requisitionId: "00000000-0000-4000-8000-0000000a04dd",
        }),
      "NOT_FOUND",
      "unknown requisition",
    );

    // End it: it leaves the partner's list but stays in the internal history.
    const ended = await admin.endPartnerAssignment({ assignmentId });
    assert.equal(ended.assignmentId, assignmentId);
    assert.ok(ended.endedAt, "endedAt stamped");

    const afterPartner = await partner.partnerListAssignedRequisitions();
    assert.equal(afterPartner.items.length, 0, "ended assignment leaves the partner dashboard");

    const afterDetail = await admin.getPartnerOrg({ partnerOrgId: adminOrgId });
    const endedRow = afterDetail.assignments.find((a) => a.assignmentId === assignmentId);
    assert.ok(endedRow, "internal history keeps the ended assignment");
    assert.equal(endedRow.status, "ended");
    assert.ok(endedRow.endedAt, "endedAt on the internal row");
    assert.equal(afterDetail.org.activeAssignmentCount, 0, "no longer counted as active");
  });

  it("Test 7: another tenant's partner org → NOT_FOUND", async () => {
    const admin = makeInternalCaller(["admin"]);
    await expectCode(
      () => admin.getPartnerOrg({ partnerOrgId: PA_ORG_B }),
      "NOT_FOUND",
      "cross-tenant getPartnerOrg",
    );
    // The same answer for the write paths — a cross-tenant id is simply absent.
    await expectCode(
      () => admin.setPartnerOrgActive({ partnerOrgId: PA_ORG_B, active: false }),
      "NOT_FOUND",
      "cross-tenant setPartnerOrgActive",
    );
    await expectCode(
      () =>
        admin.invitePartnerUser({
          partnerOrgId: PA_ORG_B,
          email: "leak@example.com",
          fullName: "Leak Probe",
          role: "partner_user",
        }),
      "NOT_FOUND",
      "cross-tenant invitePartnerUser",
    );
    // …and the other tenant's org is untouched.
    const [row] = await poolSql<{ active: boolean }[]>`
      SELECT active FROM public.partner_orgs WHERE id = ${PA_ORG_B}
    `;
    assert.equal(row?.active, true, "the other tenant's org is unchanged");
  });

  it("Test 8: setPartnerOrgActive suspends and restores the org", async () => {
    const admin = makeInternalCaller(["admin"]);
    const suspended = await admin.setPartnerOrgActive({
      partnerOrgId: hrOpsOrgId,
      active: false,
    });
    assert.equal(suspended.active, false);
    const afterSuspend = await admin.getPartnerOrg({ partnerOrgId: hrOpsOrgId });
    assert.equal(afterSuspend.org.active, false, "org reads back as suspended");
    // Suspension is a flag flip: the live invitation from test 4 survives.
    assert.equal(afterSuspend.pendingInvitations.length, 1, "invitations are not revoked");

    const restored = await admin.setPartnerOrgActive({ partnerOrgId: hrOpsOrgId, active: true });
    assert.equal(restored.active, true);
  });
});
