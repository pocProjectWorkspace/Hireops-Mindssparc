/**
 * P1.4 — partnerRevokeInvitation, the partner-admin twin of the internal
 * revoke. P1.3 let the admin SEE a pending invitation (partnerListTeam) but
 * not kill it, so a mistyped address had to wait out its 7-day expiry.
 *
 * The org check answers the IDENTICAL FORBIDDEN for other-org / nonexistent
 * ids (house probe posture); the consumed/CONFLICT and already-revoked/
 * idempotent semantics live in the shared tenant-level core, so this file
 * only proves the org fence and the end-to-end kill: after a revoke, the
 * raw token's preview reports the `revoked` dead state and the invitation
 * leaves partnerListTeam.
 *
 * (The other half of ticket P1.4 — password reset — is Supabase-hosted auth
 * with no api surface; it is covered by the portal's public-paths unit test
 * and build gates.)
 *
 * Harness follows partner-team.test.ts, fixtures minimal: one tenant, two
 * orgs (A = ours with an admin and a plain user, B = the foil).
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

// a12 synth namespace (a02 … a11 taken by the earlier partner suites).
const PW_TENANT = "00000000-0000-4000-8000-0000000a12a1";
const PW_ORG_A = "00000000-0000-4000-8000-0000000a12b1";
const PW_ORG_B = "00000000-0000-4000-8000-0000000a12b2";
const PW_ADMIN_A = "00000000-0000-4000-8000-0000000a12e1";
const PW_USER_A = "00000000-0000-4000-8000-0000000a12e2";
const PW_ADMIN_B = "00000000-0000-4000-8000-0000000a12e3";

const ADMIN_A_AUTH = randomUUID();
const USER_A_AUTH = randomUUID();
const ADMIN_B_AUTH = randomUUID();

const log = createLogger({ level: "error" });

function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-pwrevoke-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

/** Public caller for getPartnerInvitationPreview (no identity, like P0.2). */
function makePublicCaller() {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId: null,
    roles: [],
    claims: null,
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-pwrevoke-pub-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function tokenFromAcceptUrl(acceptUrl: string): string {
  const parts = acceptUrl.split("/accept-invite/");
  const token = parts[1];
  if (!token) throw new Error(`acceptUrl carries no token: ${acceptUrl}`);
  return token;
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${PW_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${PW_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${PW_TENANT}`;
  await poolSql`DELETE FROM public.partner_invitations WHERE tenant_id = ${PW_TENANT}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PW_TENANT}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${PW_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${PW_TENANT}`;
}

describe("P1.4 partnerRevokeInvitation", () => {
  beforeAll(async () => {
    await cleanup();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PW_TENANT}, 'synth-partner-pwrevoke', 'PwRevoke Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PW_ORG_A}, ${PW_TENANT}, 'Revoke Org A', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PW_ORG_B}, ${PW_TENANT}, 'Revoke Org B', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PW_ADMIN_A}, ${PW_TENANT}, ${PW_ORG_A}, ${ADMIN_A_AUTH}, 'Admin A', 'admin.a@revoke.example', 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PW_USER_A}, ${PW_TENANT}, ${PW_ORG_A}, ${USER_A_AUTH}, 'User A', 'user.a@revoke.example', 'partner_user', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PW_ADMIN_B}, ${PW_TENANT}, ${PW_ORG_B}, ${ADMIN_B_AUTH}, 'Admin B', 'admin.b@revoke.example', 'partner_admin', true)`;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: invite → revoke kills the link end to end", async () => {
    const admin = makePartnerCaller(ADMIN_A_AUTH);
    const issued = await admin.partnerInviteTeammate({
      email: "typo@revoke.example",
      fullName: "Mistyped Address",
      role: "partner_user",
    });
    const rawToken = tokenFromAcceptUrl(issued.acceptUrl);

    // Live before: listed and previewable.
    const before = await admin.partnerListTeam();
    assert.ok(
      before.invitations.some((i) => i.invitationId === issued.invitationId),
      "pending invitation is listed",
    );
    const previewBefore = await makePublicCaller().getPartnerInvitationPreview({
      token: rawToken,
    });
    assert.equal(previewBefore.state, "valid", "token previews as valid before the revoke");

    const revoked = await admin.partnerRevokeInvitation({ invitationId: issued.invitationId });
    assert.equal(revoked.invitationId, issued.invitationId);
    assert.ok(revoked.revokedAt, "revocation stamped");

    // Dead after: gone from the list, dead state on the wire.
    const after = await admin.partnerListTeam();
    assert.ok(
      !after.invitations.some((i) => i.invitationId === issued.invitationId),
      "revoked invitation leaves partnerListTeam",
    );
    const previewAfter = await makePublicCaller().getPartnerInvitationPreview({
      token: rawToken,
    });
    assert.equal(previewAfter.state, "revoked", "the raw token now previews as revoked");

    // Idempotent second revoke (shared-core semantics) — same stamp, no error.
    const again = await admin.partnerRevokeInvitation({ invitationId: issued.invitationId });
    assert.equal(again.revokedAt, revoked.revokedAt, "second revoke reports the original stamp");
  });

  it("Test 2: a partner_user is FORBIDDEN", async () => {
    const issued = await makePartnerCaller(ADMIN_A_AUTH).partnerInviteTeammate({
      email: "second@revoke.example",
      fullName: "Second Invite",
      role: "partner_user",
    });
    await assert.rejects(
      makePartnerCaller(USER_A_AUTH).partnerRevokeInvitation({
        invitationId: issued.invitationId,
      }),
      (err: unknown) =>
        err instanceof TRPCError &&
        err.code === "FORBIDDEN" &&
        err.message === "partner_admin_only",
      "non-admin partner → FORBIDDEN",
    );
  });

  it("Test 3: another org's invitation and a nonexistent id raise the identical FORBIDDEN", async () => {
    const orgBInvite = await makePartnerCaller(ADMIN_B_AUTH).partnerInviteTeammate({
      email: "foil@revoke.example",
      fullName: "Foil Invite",
      role: "partner_user",
    });
    const adminA = makePartnerCaller(ADMIN_A_AUTH);
    for (const [invitationId, label] of [
      [orgBInvite.invitationId, "org B's invitation"],
      [randomUUID(), "nonexistent invitation"],
    ] as const) {
      await assert.rejects(
        adminA.partnerRevokeInvitation({ invitationId }),
        (err: unknown) =>
          err instanceof TRPCError &&
          err.code === "FORBIDDEN" &&
          err.message === "partner_invitation_not_in_org",
        `${label} → identical FORBIDDEN`,
      );
    }
  });
});
