/**
 * P1.3 — partner-side team management + the dashboard attention feed.
 *
 * Four things this file has to prove, because each of them is a place the
 * partner tier could leak or lock up:
 *
 *   1. The ROLE gate. partnerProcedure only proves "an active partner user";
 *      the three team procedures additionally demand partner_admin, and every
 *      refusal is the identical FORBIDDEN 'partner_admin_only'.
 *   2. Invitation minting really is the SHARED core (P0.1A's
 *      createPartnerInvitation): a partner-issued invite stores only the
 *      sha256, enqueues the same partner.invitation email under the same dedup
 *      key, CONFLICTs on the same two conditions — and, the composition proof,
 *      redeems through the untouched P0.2 flow into the SAME org with the
 *      INTENDED role.
 *   3. Suspension is a real lockout: partnerProcedure requires active = true,
 *      so a suspended teammate's very next request is FORBIDDEN, and it is
 *      reversible. An admin cannot suspend themselves, and cannot touch
 *      another org's user (identical FORBIDDEN — no probing).
 *   4. The attention feed's four rules each fire on their own seeded
 *      condition, with the right href, and ANOTHER ORG'S data — same tenant,
 *      so RLS would happily return it — never appears. That last assertion is
 *      the org predicate under test, not the tenant one.
 *
 * Harness follows partner-reqs.test.ts (real appRouter via createCaller,
 * bare-sub partner ctx, poolSql fixtures) and partner-invite-accept.test.ts for
 * the one real Supabase identity redemption mints (deleted in teardown; there
 * is no test seam for Supabase auth anywhere in this codebase).
 *
 * Tests run in file order and share fixtures. a11 synth namespace (a09 =
 * partner-reqs, a10 = partner-submission-detail).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { hashPartnerInviteToken, partnerPortalBaseUrl } from "../src/lib/partner-admin";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required env: ${name}`);
  return value;
}

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

const PT_TENANT = "00000000-0000-4000-8000-0000000a11a1";
const PT_BU = "00000000-0000-4000-8000-0000000a11b1";
const PT_MEMBERSHIP = "00000000-0000-4000-8000-0000000a11b2";
const PT_POSITION = "00000000-0000-4000-8000-0000000a11c1";
const PT_JD = "00000000-0000-4000-8000-0000000a11c2";
/** Assigned just now → the new_req rule. */
const PT_REQ_NEW = "00000000-0000-4000-8000-0000000a11c3";
/** Assigned 30 days ago → must NOT be "new to you". */
const PT_REQ_OLD = "00000000-0000-4000-8000-0000000a11c4";

/** Our org, and a SECOND org in the SAME tenant — the org-predicate control. */
const PT_ORG = "00000000-0000-4000-8000-0000000a11d1";
const PT_ORG_OTHER = "00000000-0000-4000-8000-0000000a11d2";

const PT_ADMIN = "00000000-0000-4000-8000-0000000a11e1";
const PT_USER = "00000000-0000-4000-8000-0000000a11e2";
const PT_MATE = "00000000-0000-4000-8000-0000000a11e3";
const PT_OTHER_ADMIN = "00000000-0000-4000-8000-0000000a11e4";

const PT_PERSON_STALE = "00000000-0000-4000-8000-0000000a11f1";
const PT_PERSON_OFFER = "00000000-0000-4000-8000-0000000a11f2";
const PT_PERSON_EXPIRY = "00000000-0000-4000-8000-0000000a11f3";
const PT_PERSON_OTHER = "00000000-0000-4000-8000-0000000a11f4";

const PT_CAND_STALE = "00000000-0000-4000-8000-0000000a11f5";
const PT_CAND_OFFER = "00000000-0000-4000-8000-0000000a11f6";
const PT_CAND_EXPIRY = "00000000-0000-4000-8000-0000000a11f7";
const PT_CAND_OTHER = "00000000-0000-4000-8000-0000000a11f8";

const PT_APP_STALE = "00000000-0000-4000-8000-0000000a11e5";
const PT_APP_OFFER = "00000000-0000-4000-8000-0000000a11e6";
const PT_APP_EXPIRY = "00000000-0000-4000-8000-0000000a11e7";
const PT_APP_OTHER = "00000000-0000-4000-8000-0000000a11e8";

const PT_CLAIM_STALE = "00000000-0000-4000-8000-0000000a11c5";
const PT_CLAIM_OFFER = "00000000-0000-4000-8000-0000000a11c6";
const PT_CLAIM_EXPIRY = "00000000-0000-4000-8000-0000000a11c7";
const PT_CLAIM_OTHER = "00000000-0000-4000-8000-0000000a11c8";

const TENANT_SLUG = "synth-partner-team";
const TENANT_DISPLAY_NAME = "Partner-Team Synth";
const ORG_NAME = "Northstar Talent Synth";
const OTHER_ORG_NAME = "Rival Talent Synth";
const POSITION_TITLE = "Synth Team Engineer";

const NAME_STALE = "Anita Stalled";
const NAME_OFFER = "Vikram Offered";
const NAME_EXPIRY = "Meera Expiring";
const NAME_OTHER = "Rival Org Candidate";

const MATE_EMAIL = "mate-a11@northstar.example";
/** Mixed case on purpose — the shared core lower-cases on the way in. */
const INVITE_EMAIL_RAW = "Nikhil.Rao@Northstar.example";
const INVITE_EMAIL = "nikhil.rao@northstar.example";
const REDEEM_PASSWORD = "PartnerTeamA11!";

const ADMIN_AUTH = randomUUID();
const USER_AUTH = randomUUID();
const MATE_AUTH = randomUUID();
const OTHER_ADMIN_AUTH = randomUUID();

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

/** Set by test 2; deleted in teardown (a REAL Supabase identity). */
let redeemedAuthUserId: string | null = null;
let liveToken: string;
let liveInvitationId: string;

const log = createLogger({ level: "error" });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Partner caller — partnerProcedure resolves tenant + org + role from userId. */
function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-team-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** Anonymous caller — what an invitee clicking an emailed link actually is. */
function makeAnonCaller() {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId: null,
    roles: [],
    claims: null,
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-team-anon-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.partner_invitations WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${PT_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${PT_TENANT}`;
}

async function expectTRPC(
  fn: () => Promise<unknown>,
  code: string,
  message: string,
  label: string,
): Promise<void> {
  await assert.rejects(
    fn(),
    (err: unknown) => err instanceof TRPCError && err.code === code && err.message === message,
    `${label} → ${code} ${message}`,
  );
}

describe("P1.3 partner team management + attention feed", () => {
  beforeAll(async () => {
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P1.3 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PT_TENANT}, ${TENANT_SLUG}, ${TENANT_DISPLAY_NAME}, 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PT_BU}, ${PT_TENANT}, 'PT BU', 'pt-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PT_MEMBERSHIP}, ${PT_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin']::tenant_role[], 'active', ${PT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PT_POSITION}, ${PT_TENANT}, ${PT_BU}, ${POSITION_TITLE}, 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PT_JD}, ${PT_TENANT}, ${PT_POSITION}, 1, '# Role', 'approved')`;
    for (const req of [PT_REQ_NEW, PT_REQ_OLD]) {
      await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, number_of_openings, is_public, posted_at) VALUES (${req}, ${PT_TENANT}, ${PT_POSITION}, ${PT_JD}, ${PT_MEMBERSHIP}, ${PT_MEMBERSHIP}, 'posted', 1, true, now())`;
    }

    // Two orgs in ONE tenant: RLS cannot tell them apart, only the explicit
    // partner_org_id predicate can.
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG}, ${PT_TENANT}, ${ORG_NAME}, 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PT_ORG_OTHER}, ${PT_TENANT}, ${OTHER_ORG_NAME}, 'empanelled', true)`;

    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active, last_login_at) VALUES (${PT_ADMIN}, ${PT_TENANT}, ${PT_ORG}, ${ADMIN_AUTH}, 'Asha Admin', 'asha-a11@northstar.example', 'partner_admin', true, now())`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PT_USER}, ${PT_TENANT}, ${PT_ORG}, ${USER_AUTH}, 'Rohit Recruiter', 'rohit-a11@northstar.example', 'partner_user', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PT_MATE}, ${PT_TENANT}, ${PT_ORG}, ${MATE_AUTH}, 'Bala Teammate', ${MATE_EMAIL}, 'partner_user', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PT_OTHER_ADMIN}, ${PT_TENANT}, ${PT_ORG_OTHER}, ${OTHER_ADMIN_AUTH}, 'Rival Admin', 'admin-a11@rival.example', 'partner_admin', true)`;

    // Assignments: one fresh (new_req), one a month old (must not fire).
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PT_TENANT}, ${PT_ORG}, ${PT_REQ_NEW}, ${PT_MEMBERSHIP}, 'active')`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status, assigned_at) VALUES (${PT_TENANT}, ${PT_ORG}, ${PT_REQ_OLD}, ${PT_MEMBERSHIP}, 'active', now() - interval '30 days')`;

    // Four submissions, each seeded to trip exactly one rule (the two that
    // must not also trip claim_expiring get a 60-day window).
    const people: [string, string, string, string, string, string, string][] = [
      // person, candidate, application, claim, name, stage, stage-entered
      [
        PT_PERSON_STALE,
        PT_CAND_STALE,
        PT_APP_STALE,
        PT_CLAIM_STALE,
        NAME_STALE,
        "recruiter_review",
        "30 days",
      ],
      [
        PT_PERSON_OFFER,
        PT_CAND_OFFER,
        PT_APP_OFFER,
        PT_CLAIM_OFFER,
        NAME_OFFER,
        "offer_drafted",
        "2 days",
      ],
      [
        PT_PERSON_EXPIRY,
        PT_CAND_EXPIRY,
        PT_APP_EXPIRY,
        PT_CLAIM_EXPIRY,
        NAME_EXPIRY,
        "ai_screening",
        "1 day",
      ],
      [
        PT_PERSON_OTHER,
        PT_CAND_OTHER,
        PT_APP_OTHER,
        PT_CLAIM_OTHER,
        NAME_OTHER,
        "offer_drafted",
        "1 day",
      ],
    ];
    for (const [personId, candidateId, applicationId, , fullName, stage, entered] of people) {
      await poolSql`INSERT INTO public.persons (id, tenant_id, full_name) VALUES (${personId}, ${PT_TENANT}, ${fullName})`;
      await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${candidateId}, ${PT_TENANT}, ${personId}, 'partner_empanelled')`;
      await poolSql`
        INSERT INTO public.applications
          (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
        VALUES (${applicationId}, ${PT_TENANT}, ${candidateId}, ${PT_REQ_OLD}, 'partner_empanelled',
                ${stage}::application_stage, now() - ${entered}::interval)
      `;
    }
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id, claimed_via_application_id, claimed_at, expires_at, status) VALUES (${PT_CLAIM_STALE}, ${PT_TENANT}, ${PT_PERSON_STALE}, ${PT_ORG}, ${PT_USER}, ${PT_APP_STALE}, now() - interval '40 days', now() + interval '60 days', 'active')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id, claimed_via_application_id, claimed_at, expires_at, status) VALUES (${PT_CLAIM_OFFER}, ${PT_TENANT}, ${PT_PERSON_OFFER}, ${PT_ORG}, ${PT_USER}, ${PT_APP_OFFER}, now() - interval '20 days', now() + interval '60 days', 'active')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id, claimed_via_application_id, claimed_at, expires_at, status) VALUES (${PT_CLAIM_EXPIRY}, ${PT_TENANT}, ${PT_PERSON_EXPIRY}, ${PT_ORG}, ${PT_USER}, ${PT_APP_EXPIRY}, now() - interval '85 days', now() + interval '5 days', 'active')`;
    // The rival org's submission: offer stage AND a 3-day window, so it would
    // fire TWO rules if the org predicate were missing.
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id, claimed_via_application_id, claimed_at, expires_at, status) VALUES (${PT_CLAIM_OTHER}, ${PT_TENANT}, ${PT_PERSON_OTHER}, ${PT_ORG_OTHER}, ${PT_OTHER_ADMIN}, ${PT_APP_OTHER}, now() - interval '87 days', now() + interval '3 days', 'active')`;
  });

  afterAll(async () => {
    if (redeemedAuthUserId) {
      await admin.auth.admin.deleteUser(redeemedAuthUserId).catch(() => undefined);
    }
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  // ─────────────────────────── 1. role gate ───────────────────────────

  it("Test 1: a partner_user is FORBIDDEN on all three team procedures; the admin is not", async () => {
    const recruiter = makePartnerCaller(USER_AUTH);
    await expectTRPC(
      () => recruiter.partnerListTeam(),
      "FORBIDDEN",
      "partner_admin_only",
      "partnerListTeam as partner_user",
    );
    await expectTRPC(
      () =>
        recruiter.partnerInviteTeammate({
          email: "sneaky-a11@northstar.example",
          fullName: "Sneaky Invite",
          role: "partner_user",
        }),
      "FORBIDDEN",
      "partner_admin_only",
      "partnerInviteTeammate as partner_user",
    );
    await expectTRPC(
      () => recruiter.partnerSetTeammateActive({ partnerUserId: PT_MATE, active: false }),
      "FORBIDDEN",
      "partner_admin_only",
      "partnerSetTeammateActive as partner_user",
    );

    // Nothing the refused invite touched exists.
    const [pending] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.partner_invitations WHERE tenant_id = ${PT_TENANT}
    `;
    assert.equal(pending?.n, 0, "a refused invite writes no row");

    const team = await makePartnerCaller(ADMIN_AUTH).partnerListTeam();
    assert.equal(team.members.length, 3, "only THIS org's three users");
    const emails = team.members.map((m) => m.email).sort();
    assert.deepEqual(emails, [
      "asha-a11@northstar.example",
      MATE_EMAIL,
      "rohit-a11@northstar.example",
    ]);
    assert.ok(
      !team.members.some((m) => m.partnerUserId === PT_OTHER_ADMIN),
      "the rival org's admin is not on our team",
    );
    const self = team.members.find((m) => m.partnerUserId === PT_ADMIN);
    assert.equal(self?.isSelf, true, "the caller's own row is flagged");
    assert.equal(self?.role, "partner_admin");
    assert.ok(self?.lastLoginAt, "last sign-in surfaced");
    assert.equal(
      team.members.filter((m) => m.isSelf).length,
      1,
      "exactly one row is the caller's own",
    );
    assert.equal(team.invitations.length, 0, "no invitations yet");
  });

  // ─────────────────────── 2. invite + redeem ───────────────────────

  it("Test 2: the admin invites a teammate — hash-only storage, one email, and the P0.2 flow redeems it into the same org", async () => {
    const caller = makePartnerCaller(ADMIN_AUTH);
    const invited = await caller.partnerInviteTeammate({
      email: INVITE_EMAIL_RAW,
      fullName: "Nikhil Rao",
      role: "partner_user",
    });
    liveInvitationId = invited.invitationId;

    const prefix = `${partnerPortalBaseUrl()}/accept-invite/`;
    assert.ok(invited.acceptUrl.startsWith(prefix), `acceptUrl shape: ${invited.acceptUrl}`);
    liveToken = invited.acceptUrl.slice(prefix.length);

    const [row] = await poolSql<
      {
        partner_org_id: string;
        email: string;
        intended_role: string;
        token_hash: string;
        created_by_membership_id: string | null;
      }[]
    >`
      SELECT partner_org_id, email, intended_role::text AS intended_role, token_hash,
             created_by_membership_id
      FROM public.partner_invitations WHERE id = ${liveInvitationId}
    `;
    assert.ok(row, "the invitation row exists");
    assert.equal(row.partner_org_id, PT_ORG, "minted into the CALLER'S org, not an input");
    assert.equal(row.email, INVITE_EMAIL, "stored lower-cased");
    assert.equal(row.intended_role, "partner_user");
    assert.equal(
      row.token_hash,
      hashPartnerInviteToken(liveToken),
      "only the sha256 of the emailed token is persisted",
    );
    assert.notEqual(row.token_hash, liveToken, "the raw token is not in the row");
    assert.equal(
      row.created_by_membership_id,
      null,
      "a partner-issued invite has no tenant membership to record (schema FK)",
    );

    const [mail] = await poolSql<
      { template_key: string; recipient_email: string; recipient_type: string }[]
    >`
      SELECT template_key, recipient_email, recipient_type
      FROM public.notification_outbox
      WHERE tenant_id = ${PT_TENANT} AND dedup_key = ${`partner_invitation:${liveInvitationId}`}
    `;
    assert.ok(mail, "the invitation email was enqueued under the shared dedup key");
    assert.equal(mail.template_key, "partner.invitation");
    assert.equal(mail.recipient_email, INVITE_EMAIL);
    assert.equal(mail.recipient_type, "partner");

    const team = await caller.partnerListTeam();
    assert.equal(team.invitations.length, 1, "the live invitation is on the team page");
    assert.equal(team.invitations[0]?.email, INVITE_EMAIL);
    assert.equal(team.invitations[0]?.intendedRole, "partner_user");

    // Same CONFLICT rules as the internal path: a live invite for that email…
    await assert.rejects(
      caller.partnerInviteTeammate({
        email: INVITE_EMAIL,
        fullName: "Nikhil Again",
        role: "partner_user",
      }),
      (err: unknown) => err instanceof TRPCError && err.code === "CONFLICT",
      "duplicate live invitation → CONFLICT",
    );
    // …and an address that is already an active teammate.
    await assert.rejects(
      caller.partnerInviteTeammate({
        email: MATE_EMAIL.toUpperCase(),
        fullName: "Bala Twice",
        role: "partner_user",
      }),
      (err: unknown) => err instanceof TRPCError && err.code === "CONFLICT",
      "existing active teammate → CONFLICT",
    );
    assert.equal(
      (await caller.partnerListTeam()).invitations.length,
      1,
      "neither conflict minted a second invitation",
    );

    // Composition: the UNTOUCHED P0.2 redeem flow spends a partner-issued link.
    const out = await makeAnonCaller().redeemPartnerInvitation({
      token: liveToken,
      password: REDEEM_PASSWORD,
      fullName: "Nikhil Rao",
      attestations: { terms: true, authority: true, dpdpaConsent: true },
    });
    assert.equal(out.outcome, "accepted", `redeem outcome: ${JSON.stringify(out)}`);
    if (out.outcome !== "accepted") return;
    assert.equal(out.orgName, ORG_NAME, "landed in the inviting admin's org");

    const [redeemed] = await poolSql<
      { id: string; partner_org_id: string; user_id: string; role: string; active: boolean }[]
    >`
      SELECT id, partner_org_id, user_id, role::text AS role, active
      FROM public.partner_users WHERE tenant_id = ${PT_TENANT} AND email = ${INVITE_EMAIL}
    `;
    assert.ok(redeemed, "a partner_users row was minted");
    redeemedAuthUserId = redeemed.user_id; // teardown deletes the real identity
    assert.equal(redeemed.partner_org_id, PT_ORG, "the SAME org the admin invited into");
    assert.equal(redeemed.role, "partner_user", "the INTENDED role from the invitation");
    assert.equal(redeemed.active, true);

    const me = await makePartnerCaller(redeemed.user_id).partnerGetMe();
    assert.equal(me.orgName, ORG_NAME);
    assert.equal(me.role, "partner_user");

    // A consumed invitation drops off the pending list; the new teammate joins.
    const after = await caller.partnerListTeam();
    assert.equal(after.invitations.length, 0, "consumed invitations are not 'live'");
    assert.equal(after.members.length, 4, "the redeemer is now a teammate");
  });

  // ─────────────────── 3. suspend / reactivate ───────────────────

  it("Test 3: suspending a teammate locks them out of the portal, reactivating restores them, and self-suspension is refused", async () => {
    const caller = makePartnerCaller(ADMIN_AUTH);

    // Before: the teammate is a working partner user.
    const before = await makePartnerCaller(MATE_AUTH).partnerGetMe();
    assert.equal(before.partnerUserId, PT_MATE);

    const off = await caller.partnerSetTeammateActive({ partnerUserId: PT_MATE, active: false });
    assert.equal(off.active, false);

    // The lockout: partnerProcedure requires active = true, so their very next
    // request is refused — not just hidden from the UI.
    await expectTRPC(
      () => makePartnerCaller(MATE_AUTH).partnerGetMe(),
      "FORBIDDEN",
      "not_a_partner_account",
      "a suspended teammate",
    );

    const listed = await caller.partnerListTeam();
    const mate = listed.members.find((m) => m.partnerUserId === PT_MATE);
    assert.equal(mate?.active, false, "still listed, so the admin can reverse it");

    const on = await caller.partnerSetTeammateActive({ partnerUserId: PT_MATE, active: true });
    assert.equal(on.active, true);
    assert.equal(
      (await makePartnerCaller(MATE_AUTH).partnerGetMe()).partnerUserId,
      PT_MATE,
      "reactivation restores access",
    );

    // Self-suspension would lock the admin — and possibly the whole org — out.
    await expectTRPC(
      () => caller.partnerSetTeammateActive({ partnerUserId: PT_ADMIN, active: false }),
      "BAD_REQUEST",
      "cannot_deactivate_self",
      "an admin suspending themselves",
    );
    assert.equal(
      (await makePartnerCaller(ADMIN_AUTH).partnerGetMe()).partnerUserId,
      PT_ADMIN,
      "the admin is still active",
    );

    // Another org's user and a nonexistent id are the IDENTICAL refusal.
    for (const [id, label] of [
      [PT_OTHER_ADMIN, "another org's admin"],
      [randomUUID(), "a nonexistent partner user"],
    ] as [string, string][]) {
      await expectTRPC(
        () => caller.partnerSetTeammateActive({ partnerUserId: id, active: false }),
        "FORBIDDEN",
        "partner_user_not_in_org",
        label,
      );
    }
    const [rival] = await poolSql<{ active: boolean }[]>`
      SELECT active FROM public.partner_users WHERE id = ${PT_OTHER_ADMIN}
    `;
    assert.equal(rival?.active, true, "the rival org's admin was untouched");
  });

  // ────────────────────── 4. attention feed ──────────────────────

  it("Test 4: the feed fires all four rules with the right hrefs, and never carries another org's data", async () => {
    const feed = await makePartnerCaller(ADMIN_AUTH).partnerGetAttentionFeed();
    const kinds = new Set(feed.items.map((i) => i.kind));
    for (const kind of ["new_req", "stale_submission", "offer_stage", "claim_expiring"]) {
      assert.ok(kinds.has(kind as never), `feed carries a ${kind} item`);
    }

    const newReq = feed.items.filter((i) => i.kind === "new_req");
    assert.equal(newReq.length, 1, "only the assignment made this week");
    assert.equal(newReq[0]?.href, `/reqs/${PT_REQ_NEW}`);
    assert.ok(newReq[0]?.title.includes(POSITION_TITLE), "named by its role title");

    const stale = feed.items.filter((i) => i.kind === "stale_submission");
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.href, `/submissions/${PT_CLAIM_STALE}`);
    assert.ok(stale[0]?.title.includes(NAME_STALE), "the candidate the partner submitted");

    const offer = feed.items.filter((i) => i.kind === "offer_stage");
    assert.equal(offer.length, 1);
    assert.equal(offer[0]?.href, `/submissions/${PT_CLAIM_OFFER}`);
    assert.ok(offer[0]?.title.includes(NAME_OFFER));

    const expiring = feed.items.filter((i) => i.kind === "claim_expiring");
    assert.equal(expiring.length, 1, "the 60-day windows are not 'expiring'");
    assert.equal(expiring[0]?.href, `/submissions/${PT_CLAIM_EXPIRY}`);
    assert.ok(expiring[0]?.title.includes(NAME_EXPIRY));

    // Newest first, and the cap holds.
    const dates = feed.items.map((i) => i.occurredAt);
    assert.deepEqual(dates, [...dates].sort().reverse(), "sorted newest first");
    assert.ok(feed.items.length <= 20, "capped at 20");

    // The org predicate: the rival org's claim is in the SAME tenant and would
    // fire two rules, so RLS alone would leak it.
    const blob = JSON.stringify(feed.items);
    assert.ok(!blob.includes(PT_CLAIM_OTHER), "no rival-org claim id anywhere in the feed");
    assert.ok(!blob.includes(NAME_OTHER), "no rival-org candidate name anywhere in the feed");

    // §6.3: the copy is stage + date + name + role title, nothing else. The
    // recruiter/HM behind these reqs is TEST_USER_FOR_FK's membership.
    assert.ok(!blob.includes(PT_MEMBERSHIP), "no internal actor identity in the copy");

    // A plain recruiter gets the same org-scoped feed — it is not admin-only.
    const asRecruiter = await makePartnerCaller(USER_AUTH).partnerGetAttentionFeed();
    assert.deepEqual(
      asRecruiter.items.map((i) => i.href).sort(),
      feed.items.map((i) => i.href).sort(),
      "both partner roles see their org's feed",
    );
  });
});
