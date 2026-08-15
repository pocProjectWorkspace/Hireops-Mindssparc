/**
 * P0.2 — partner invitation acceptance (redeem link → account → partner_users).
 *
 * The other end of partner-admin.test.ts: that file proves invitePartnerUser
 * mints a single-use token; this one proves the invitee can spend it exactly
 * once and lands as a real portal user.
 *
 * Harness: the real appRouter via createCaller. Three ctx shapes, each the one
 * the corresponding tier builds in production —
 *   - internal (tenantId + roles + claims) to mint the live invitation through
 *     the REAL invitePartnerUser, so the token under test is a genuine one
 *     pulled out of the returned acceptUrl, not a fixture;
 *   - anonymous (everything null) for the two PUBLIC procedures under test;
 *   - partner (userId only) to prove the minted identity now resolves through
 *     partnerProcedure.
 *
 * Auth users are REAL. There is no NODE_ENV=test seam for Supabase auth
 * anywhere in this codebase — cand-01-accounts.test.ts creates a real auth
 * user through the service-role admin API and deletes it in teardown, and this
 * file does the same (two of them: the one redemption mints, and the squatter
 * that forces the email_in_use path).
 *
 * Coverage:
 *   1. Preview of a live invitation → org, tenant display name, invitee email,
 *      intended role, expiry.
 *   2. Preview of an unmatched token → exactly { state: "invalid" } — no tenant,
 *      no org, nothing to probe with.
 *   3. Redeem → an ACTIVE partner_users row carrying the INTENDED role, the
 *      invitation stamped consumed by the new auth user, and partnerGetMe
 *      resolving that identity.
 *   4. Replaying the same token → already_used, and no second partner_users row.
 *   5. Expired invitation → expired (preview and redeem).
 *   6. Revoked invitation → revoked (preview and redeem).
 *   7. Any attestation not literal true → BAD_REQUEST from zod, nothing written.
 *   8. An email that already has a Supabase identity → email_in_use, the
 *      invitation left LIVE and the existing identity untouched.
 *
 * Tests run in file order and share fixtures (same convention as
 * partner-admin.test.ts): test 1 mints the invitation tests 3, 4 and 7 act on.
 * a05 synth namespace (partner-auth a02, partner-submission a03, partner-admin
 * + cand-01 a04).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { hashPartnerInviteToken, partnerPortalBaseUrl } from "../src/lib/partner-admin";

/**
 * Read-or-die, so the three Supabase values are plain `string` everywhere
 * below — cand-01-accounts.test.ts scatters `!` assertions instead, which the
 * src lint rules forbid.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required env: ${name}`);
  return value;
}

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_ANON_KEY = requiredEnv("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

const PI_TENANT = "00000000-0000-4000-8000-0000000a05a1";
const PI_BU = "00000000-0000-4000-8000-0000000a05b1";
const PI_MEMBERSHIP = "00000000-0000-4000-8000-0000000a05b2";
const PI_ORG = "00000000-0000-4000-8000-0000000a05c1";
const PI_INVITE_EXPIRED = "00000000-0000-4000-8000-0000000a05d1";
const PI_INVITE_REVOKED = "00000000-0000-4000-8000-0000000a05d2";
const PI_INVITE_SQUATTED = "00000000-0000-4000-8000-0000000a05d3";

const TENANT_SLUG = "synth-partner-invite";
const TENANT_DISPLAY_NAME = "Partner-Invite Synth";
const ORG_NAME = "Meridian Talent Synth";

// Mixed case on purpose — invitePartnerUser lower-cases on the way in, and the
// account is minted against the STORED address.
const INVITE_EMAIL_RAW = "Devi.Krishnan@Meridian.example";
const INVITE_EMAIL = "devi.krishnan@meridian.example";
const EXPIRED_EMAIL = "expired-a05@meridian.example";
const REVOKED_EMAIL = "revoked-a05@meridian.example";
const SQUATTED_EMAIL = "squatter-a05@hireops-dev.local";

const REDEEM_PASSWORD = "PartnerAccept123!";
const SQUATTER_PASSWORD = "SquatterA05-do-not-reuse";

// Raw tokens for the invitations we hand-craft (the live one comes from the
// real invitePartnerUser). Only their sha256 is ever inserted — same
// discipline the production path follows.
const EXPIRED_TOKEN = randomBytes(32).toString("base64url");
const REVOKED_TOKEN = randomBytes(32).toString("base64url");
const SQUATTED_TOKEN = randomBytes(32).toString("base64url");

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

/** Live invitation minted in test 1 and spent in test 3. */
let liveToken: string;
let liveInvitationId: string;

/** Auth identities this file creates — deleted in teardown, both of them. */
let redeemedAuthUserId: string | null = null;
let squatterAuthUserId: string | null = null;

const log = createLogger({ level: "error" });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Internal-staff caller — the ctx protectedProcedure builds from a JWT. */
function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: PI_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: PI_TENANT, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-invite-${randomUUID()}`,
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
    requestId: `test-partner-invite-anon-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** Partner caller — partnerProcedure resolves everything from userId. */
function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-invite-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.partner_invitations WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${PI_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${PI_TENANT}`;
}

interface PartnerUserRow {
  id: string;
  partner_org_id: string;
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
  active: boolean;
}

/**
 * Create the fixture auth identity, or adopt the one a previously-crashed run
 * left behind (its password is reset so this run's assertions hold). Only ever
 * called for SQUATTED_EMAIL, which belongs to this file alone.
 */
async function ensureAuthUser(email: string, password: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data?.user?.id) return created.data.user.id;
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list.data?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) {
    throw new Error(
      `P0.2 setup: could not create or find the fixture auth user ${email}: ${
        created.error?.message ?? "unknown"
      }`,
    );
  }
  await admin.auth.admin.updateUserById(existing.id, { password });
  return existing.id;
}

async function partnerUserRows(): Promise<PartnerUserRow[]> {
  return poolSql<PartnerUserRow[]>`
    SELECT id, partner_org_id, user_id, full_name, email, phone, role::text AS role, active
    FROM public.partner_users WHERE tenant_id = ${PI_TENANT}
  `;
}

describe("P0.2 partner invitation acceptance", () => {
  beforeAll(async () => {
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P0.2 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PI_TENANT}, ${TENANT_SLUG}, ${TENANT_DISPLAY_NAME}, 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PI_BU}, ${PI_TENANT}, 'PI BU', 'pi-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PI_MEMBERSHIP}, ${PI_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin']::tenant_role[], 'active', ${PI_BU})`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PI_ORG}, ${PI_TENANT}, ${ORG_NAME}, 'empanelled', true)`;

    // Three hand-crafted invitations. invitePartnerUser can only mint LIVE
    // ones, so expired / revoked / squatted-email are inserted directly — the
    // token discipline is identical (only the sha256 lands in the row).
    await poolSql`
      INSERT INTO public.partner_invitations
        (id, tenant_id, partner_org_id, email, intended_role, token_hash, expires_at, created_by_membership_id)
      VALUES (${PI_INVITE_EXPIRED}, ${PI_TENANT}, ${PI_ORG}, ${EXPIRED_EMAIL}, 'partner_user',
              ${hashPartnerInviteToken(EXPIRED_TOKEN)}, now() - interval '1 day', ${PI_MEMBERSHIP})
    `;
    await poolSql`
      INSERT INTO public.partner_invitations
        (id, tenant_id, partner_org_id, email, intended_role, token_hash, expires_at, revoked_at, created_by_membership_id)
      VALUES (${PI_INVITE_REVOKED}, ${PI_TENANT}, ${PI_ORG}, ${REVOKED_EMAIL}, 'partner_user',
              ${hashPartnerInviteToken(REVOKED_TOKEN)}, now() + interval '5 days', now(), ${PI_MEMBERSHIP})
    `;
    await poolSql`
      INSERT INTO public.partner_invitations
        (id, tenant_id, partner_org_id, email, intended_role, token_hash, expires_at, created_by_membership_id)
      VALUES (${PI_INVITE_SQUATTED}, ${PI_TENANT}, ${PI_ORG}, ${SQUATTED_EMAIL}, 'partner_user',
              ${hashPartnerInviteToken(SQUATTED_TOKEN)}, now() + interval '5 days', ${PI_MEMBERSHIP})
    `;

    // The squatter: an auth identity that already owns the invited address.
    squatterAuthUserId = await ensureAuthUser(SQUATTED_EMAIL, SQUATTER_PASSWORD);
  });

  afterAll(async () => {
    for (const id of [redeemedAuthUserId, squatterAuthUserId]) {
      if (id) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
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

  // ─────────────────────────── preview ───────────────────────────

  it("Test 1: preview of a freshly-minted invitation shows org, tenant, email, role, expiry", async () => {
    const invited = await makeInternalCaller(["admin"]).invitePartnerUser({
      partnerOrgId: PI_ORG,
      email: INVITE_EMAIL_RAW,
      fullName: "Devi Krishnan",
      role: "partner_admin",
    });
    liveInvitationId = invited.invitationId;

    const prefix = `${partnerPortalBaseUrl()}/accept-invite/`;
    assert.ok(invited.acceptUrl.startsWith(prefix), `acceptUrl shape: ${invited.acceptUrl}`);
    liveToken = invited.acceptUrl.slice(prefix.length);

    const preview = await makeAnonCaller().getPartnerInvitationPreview({ token: liveToken });
    assert.equal(preview.state, "valid", "a fresh invitation previews as valid");
    if (preview.state !== "valid") return; // narrowing for the assertions below
    assert.equal(preview.orgName, ORG_NAME);
    assert.equal(preview.tenantDisplayName, TENANT_DISPLAY_NAME);
    assert.equal(preview.email, INVITE_EMAIL, "the STORED (lower-cased) address");
    assert.equal(preview.intendedRole, "partner_admin");
    assert.equal(
      new Date(preview.expiresAt).toISOString(),
      new Date(invited.expiresAt).toISOString(),
      "the persisted expiry, echoed",
    );
  });

  it("Test 2: an unmatched token previews as a bare `invalid` — nothing leaked", async () => {
    const preview = await makeAnonCaller().getPartnerInvitationPreview({
      token: randomBytes(32).toString("base64url"),
    });
    assert.deepEqual(
      preview,
      { state: "invalid" },
      "invalid carries NO org, tenant or email — an unmatched token must not be a probe",
    );

    // A structurally silly token is the same answer, not a crash.
    const junk = await makeAnonCaller().getPartnerInvitationPreview({ token: "bogus-token" });
    assert.deepEqual(junk, { state: "invalid" });
  });

  // ─────────────────────────── redeem ───────────────────────────

  it("Test 3: redeem mints the auth identity + an ACTIVE partner_users row and consumes the invitation", async () => {
    const out = await makeAnonCaller().redeemPartnerInvitation({
      token: liveToken,
      password: REDEEM_PASSWORD,
      fullName: "  Devi Krishnan  ",
      phone: "+91 98765 43210",
      attestations: { terms: true, authority: true, dpdpaConsent: true },
    });
    assert.equal(out.outcome, "accepted", `redeem outcome: ${JSON.stringify(out)}`);
    if (out.outcome !== "accepted") return;
    assert.equal(out.email, INVITE_EMAIL);
    assert.equal(out.orgName, ORG_NAME);

    const rows = await partnerUserRows();
    assert.equal(rows.length, 1, "exactly one partner user");
    const pu = rows[0];
    assert.ok(pu);
    assert.equal(pu.id, out.partnerUserId);
    assert.equal(pu.partner_org_id, PI_ORG);
    assert.equal(pu.role, "partner_admin", "the INTENDED role from the invitation");
    assert.equal(pu.active, true, "new partner users are active");
    assert.equal(pu.full_name, "Devi Krishnan", "name trimmed");
    assert.equal(pu.email, INVITE_EMAIL, "email comes from the invitation, not the form");
    assert.equal(pu.phone, "+91 98765 43210");
    redeemedAuthUserId = pu.user_id; // teardown deletes the real auth user

    const [inv] = await poolSql<{ consumed_at: Date | null; consumed_by_user_id: string | null }[]>`
      SELECT consumed_at, consumed_by_user_id FROM public.partner_invitations
      WHERE id = ${liveInvitationId}
    `;
    assert.ok(inv?.consumed_at, "invitation stamped consumed");
    assert.equal(inv.consumed_by_user_id, pu.user_id, "consumed by the identity we just minted");

    // The whole point: that identity now resolves through partnerProcedure.
    const me = await makePartnerCaller(pu.user_id).partnerGetMe();
    assert.equal(me.orgName, ORG_NAME);
    assert.equal(me.role, "partner_admin");
    assert.equal(me.displayName, "Devi Krishnan");

    // The attestations are recorded on the api_audit_logs intent row, with the
    // token and password redacted by sanitiseForAudit. The write is
    // fire-and-forget, so poll briefly rather than assume it has landed.
    let auditInput: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !auditInput; i += 1) {
      const [row] = await poolSql<{ input_json: { input?: Record<string, unknown> } }[]>`
        SELECT input_json FROM public.api_audit_logs
        WHERE tenant_id = ${PI_TENANT} AND action = 'redeem_partner_invitation'
        ORDER BY created_at DESC LIMIT 1
      `;
      auditInput = row?.input_json?.input;
      if (!auditInput) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(auditInput, "an api_audit_logs intent row was written");
    assert.deepEqual(
      auditInput.attestations,
      { terms: true, authority: true, dpdpaConsent: true },
      "all three attestations persisted",
    );
    assert.equal(auditInput.password, "[redacted]", "password never stored");
    assert.equal(auditInput.token, "[redacted]", "raw token never stored");
  });

  it("Test 4: replaying the same token → already_used, and no second account", async () => {
    const again = await makeAnonCaller().redeemPartnerInvitation({
      token: liveToken,
      password: "SomeOtherPassword123!",
      fullName: "Impostor",
      attestations: { terms: true, authority: true, dpdpaConsent: true },
    });
    assert.equal(again.outcome, "already_used");

    const rows = await partnerUserRows();
    assert.equal(rows.length, 1, "the replay created no second partner user");
    assert.equal(rows[0]?.full_name, "Devi Krishnan", "and did not overwrite the first");

    // The preview agrees — this is what the page renders on a replayed link.
    const preview = await makeAnonCaller().getPartnerInvitationPreview({ token: liveToken });
    assert.deepEqual(preview, { state: "already_used" });
  });

  it("Test 5: an expired invitation is `expired` in both preview and redeem", async () => {
    assert.deepEqual(await makeAnonCaller().getPartnerInvitationPreview({ token: EXPIRED_TOKEN }), {
      state: "expired",
    });
    const out = await makeAnonCaller().redeemPartnerInvitation({
      token: EXPIRED_TOKEN,
      password: REDEEM_PASSWORD,
      fullName: "Too Late",
      attestations: { terms: true, authority: true, dpdpaConsent: true },
    });
    assert.equal(out.outcome, "expired");
    assert.equal((await partnerUserRows()).length, 1, "no account minted for an expired link");
  });

  it("Test 6: a revoked invitation is `revoked` in both preview and redeem", async () => {
    assert.deepEqual(await makeAnonCaller().getPartnerInvitationPreview({ token: REVOKED_TOKEN }), {
      state: "revoked",
    });
    const out = await makeAnonCaller().redeemPartnerInvitation({
      token: REVOKED_TOKEN,
      password: REDEEM_PASSWORD,
      fullName: "Withdrawn",
      attestations: { terms: true, authority: true, dpdpaConsent: true },
    });
    assert.equal(out.outcome, "revoked");
    assert.equal((await partnerUserRows()).length, 1, "no account minted for a revoked link");
  });

  // ──────────────────────── attestations ────────────────────────

  it("Test 7: every attestation must be literal true — zod rejects otherwise", async () => {
    const anon = makeAnonCaller();
    const base = {
      token: SQUATTED_TOKEN,
      password: REDEEM_PASSWORD,
      fullName: "Unticked Box",
    };
    const cases: [string, { terms: boolean; authority: boolean; dpdpaConsent: boolean }][] = [
      ["terms unticked", { terms: false, authority: true, dpdpaConsent: true }],
      ["authority unticked", { terms: true, authority: false, dpdpaConsent: true }],
      ["dpdpa unticked", { terms: true, authority: true, dpdpaConsent: false }],
    ];
    for (const [label, attestations] of cases) {
      await expectCode(
        () =>
          anon.redeemPartnerInvitation({
            ...base,
            // The input type demands `true`; the point of the test is what
            // happens when a client sends something else.
            attestations: attestations as { terms: true; authority: true; dpdpaConsent: true },
          }),
        "BAD_REQUEST",
        label,
      );
    }
    assert.equal((await partnerUserRows()).length, 1, "no account minted by a rejected attempt");
    const [inv] = await poolSql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM public.partner_invitations WHERE id = ${PI_INVITE_SQUATTED}
    `;
    assert.equal(inv?.consumed_at, null, "the invitation is untouched by a rejected attempt");
  });

  // ───────────────────────── email_in_use ─────────────────────────

  it("Test 8: an email that already has an auth identity → email_in_use, invitation left live", async () => {
    // Preview is fine — the address being taken is only discovered on redeem.
    const preview = await makeAnonCaller().getPartnerInvitationPreview({ token: SQUATTED_TOKEN });
    assert.equal(preview.state, "valid", "the invitation itself is live");

    const out = await makeAnonCaller().redeemPartnerInvitation({
      token: SQUATTED_TOKEN,
      password: "DifferentPassword123!",
      fullName: "Squatter Collision",
      attestations: { terms: true, authority: true, dpdpaConsent: true },
    });
    assert.equal(out.outcome, "email_in_use", "a clean typed outcome, not a 500");

    assert.equal((await partnerUserRows()).length, 1, "no partner user created");
    const [inv] = await poolSql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM public.partner_invitations WHERE id = ${PI_INVITE_SQUATTED}
    `;
    assert.equal(inv?.consumed_at, null, "the invitation stays live — it wasn't burnt");

    // The load-bearing security assertion: the redemption did NOT take the
    // existing identity over. Its ORIGINAL password still signs in — which
    // would fail if we had reused createOrResolveAuthUser (that helper resets
    // the password of the identity it resolves).
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anonClient.auth.signInWithPassword({
      email: SQUATTED_EMAIL,
      password: SQUATTER_PASSWORD,
    });
    assert.equal(signIn.error, null, "the pre-existing identity's own password still works");
    assert.equal(signIn.data.user?.id, squatterAuthUserId, "and it is the same identity");
  });
});
