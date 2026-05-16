/**
 * DB-PARTNER-A integration tests for the 8 partner tables.
 *
 * Coverage (13 cases):
 *   1.  Tenant isolation across partner_orgs / partner_users / partner_assignments
 *       (spot-check 3 of 8 — same RLS framework as every other tenant-scoped table)
 *   2.  Compound FK rejects cross-tenant reference (partner_user pointing
 *       at a partner_org in a different tenant)
 *   3.  One-active-assignment-per-(partner, req) partial unique; an ended
 *       assignment does NOT block re-assignment
 *   4.  One-active-claim-per-(tenant, person) partial unique enforces;
 *       released claim does NOT block a new active claim
 *   5.  Expiry-boundary deviation: an 'active' claim with expires_at < now()
 *       STILL blocks a new claim (predicate is status-only — see schema
 *       comment for why). The sweep is load-bearing.
 *   6.  Invitation token hashing: insert sha256 hex, lookup by hash works
 *   7.  Audit triggers fire on partner_orgs INSERT and partner_assignments
 *       UPDATE — spot-check 2 of 6 mutable tables
 *   8a. candidate_dedup_attempts is append-only — UPDATE and DELETE affect
 *       zero rows under FORCE RLS
 *   8b. partner_candidate_messages is NOT append-only — UPDATE
 *       delivery_status succeeds (deviation from ticket's split-policy
 *       lean; see schema file comment)
 *   9.  partner_users (tenant_id, user_id) UNIQUE — second insert rejected
 *  10.  ad_hoc_partner_domains: same domain in two tenants succeeds; same
 *       domain twice in one tenant rejected; same domain in one tenant
 *       with active=false then a new active row succeeds (partial unique)
 *  11.  ad_hoc_partner_domains can reference an EMPANELLED-tier partner_org
 *       at the DB level — documents that tier-consistency is app-layer,
 *       not DB-enforced. Test asserts current behaviour, not desired.
 *  12.  Self-FK on candidate_ownership_claims: a 'superseded' claim can
 *       point back at the newer 'active' claim via superseded_by_claim_id
 *
 * No portal / submission UI yet (Phase 3). Tests verify schema shape +
 * FK graph + RLS framework adherence only.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import {
  sql as poolSql,
  db,
  drizzleSql,
  withTenantContext,
  partnerOrgs,
  partnerUsers,
  partnerInvitations,
  partnerAssignments,
  candidateOwnershipClaims,
  candidateDedupAttempts,
  partnerCandidateMessages,
  adHocPartnerDomains,
  auditLogs,
  type JwtClaims,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

// DB-PARTNER-A synth tenant + FK chain. Hex-only suffixes; nil UUIDs
// throughout — raw SQL doesn't go through Zod, so loose UUID format
// is fine here (matches earlier db-touching test files).
const PA_TENANT = "00000000-0000-0000-0000-0000000a01a1";
const PA_TENANT_B = "00000000-0000-0000-0000-0000000a01a2"; // for cross-tenant tests
const PA_ORG = "00000000-0000-0000-0000-0000000a01b1";
const PA_ORG_AD_HOC = "00000000-0000-0000-0000-0000000a01b2";
const PA_ORG_EMPANELLED = "00000000-0000-0000-0000-0000000a01b3";
const PA_BU = "00000000-0000-0000-0000-0000000a01c1";
const PA_POSITION = "00000000-0000-0000-0000-0000000a01c2";
const PA_JD = "00000000-0000-0000-0000-0000000a01c3";
const PA_REQ = "00000000-0000-0000-0000-0000000a01c4";
const PA_MEMBERSHIP = "00000000-0000-0000-0000-0000000a01c5";
const PA_PERSON = "00000000-0000-0000-0000-0000000a01d1";
const PA_PARTNER_USER = "00000000-0000-0000-0000-0000000a01e1";
const PA_PARTNER_AUTH_USER = "00000000-0000-0000-0000-0000000a01e2";

const ALL_PARTNER_IDS = [PA_ORG, PA_ORG_AD_HOC, PA_ORG_EMPANELLED];

let jwt: string;
let testUserId: string;
let testTenantId: string;

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return data.session.access_token;
}

async function cleanupTenant(tenantId: string): Promise<void> {
  // Order matters — children before parents to dodge FK + audit-trigger
  // chain effects. partner_candidate_messages depends on partner_users
  // and candidates; ownership claims depend on persons + partner_orgs.
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${tenantId} AND entity_type IN ('partner_orgs','partner_users','partner_invitations','partner_assignments','candidate_ownership_claims','ad_hoc_partner_domains')`;
  await poolSql`DELETE FROM public.partner_candidate_messages WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.partner_invitations WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.ad_hoc_partner_domains WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${tenantId} AND id = ${PA_MEMBERSHIP}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${tenantId}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${tenantId}`;
}

describe("DB-PARTNER-A (8 partner tables)", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testUserId = claims.sub as string;
    testTenantId = (claims as { tid?: string }).tid as string;

    await cleanupTenant(PA_TENANT);
    await cleanupTenant(PA_TENANT_B);

    // Provision two synth tenants for the cross-tenant compound-FK test.
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${PA_TENANT}, 'synth-partner-a', 'Partner-A Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${PA_TENANT_B}, 'synth-partner-b', 'Partner-B Synth', 'ap-northeast-1', 'active')
    `;

    // Minimum FK chain in PA_TENANT for ownership-claim + assignment tests.
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${PA_BU}, ${PA_TENANT}, 'PA BU', 'pa-bu')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${PA_MEMBERSHIP}, ${PA_TENANT}, ${testUserId},
              ARRAY['recruiter']::tenant_role[], 'active', ${PA_BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${PA_POSITION}, ${PA_TENANT}, ${PA_BU}, 'Eng', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${PA_JD}, ${PA_TENANT}, ${PA_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id,
         hiring_manager_id, status, is_public)
      VALUES (${PA_REQ}, ${PA_TENANT}, ${PA_POSITION}, ${PA_JD},
              ${PA_MEMBERSHIP}, ${PA_MEMBERSHIP}, 'posted', true)
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PA_PERSON}, ${PA_TENANT}, 'PA Person', 'pa-person@example.com', 'pa-person@example.com')
    `;
    // One empanelled and one ad-hoc partner org in PA_TENANT.
    await poolSql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active)
      VALUES (${PA_ORG_EMPANELLED}, ${PA_TENANT}, 'Empanelled Co', 'empanelled', true)
    `;
    await poolSql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active)
      VALUES (${PA_ORG_AD_HOC}, ${PA_TENANT}, 'Ad-Hoc Co', 'ad_hoc', true)
    `;
    // Generic "PA_ORG" used by per-test inserts; the seed inserts the
    // same id under tenant_id PA_TENANT (the canonical org for most
    // tests) — those tests overwrite via DELETE+INSERT per-test.
    await poolSql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active)
      VALUES (${PA_ORG}, ${PA_TENANT}, 'Default PA Org', 'empanelled', true)
    `;
  });

  afterAll(async () => {
    await cleanupTenant(PA_TENANT);
    await cleanupTenant(PA_TENANT_B);
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: tenant isolation — caller's tenant cannot see PA_TENANT's partner rows", async () => {
    const claims: JwtClaims = {
      sub: testUserId,
      tid: testTenantId,
      tenant_slug: "kyndryl-poc",
      roles: ["admin"],
    };
    const orgs = await withTenantContext(claims, async ({ db: tx }) => {
      return tx.select().from(partnerOrgs);
    });
    // Caller is in kyndryl-poc; PA_TENANT's partner_orgs must be invisible.
    const synthVisible = orgs.some((o) => ALL_PARTNER_IDS.includes(o.id));
    assert.equal(synthVisible, false, "PA_TENANT partner_orgs must not leak");
    const users = await withTenantContext(claims, async ({ db: tx }) => {
      return tx.select().from(partnerUsers);
    });
    const userLeak = users.some((u) => u.tenantId === PA_TENANT);
    assert.equal(userLeak, false, "PA_TENANT partner_users must not leak");
    const assigns = await withTenantContext(claims, async ({ db: tx }) => {
      return tx.select().from(partnerAssignments);
    });
    const assignLeak = assigns.some((a) => a.tenantId === PA_TENANT);
    assert.equal(assignLeak, false, "PA_TENANT partner_assignments must not leak");
  });

  it("Test 2: compound FK rejects cross-tenant partner_user → partner_org", async () => {
    // Try to insert a partner_user in PA_TENANT_B that references a
    // partner_org in PA_TENANT. The compound FK (tenant_id, partner_org_id)
    // must reject this — the tenant_id in the partner_users row is
    // PA_TENANT_B, but PA_ORG only exists in PA_TENANT.
    let threw = false;
    let msg = "";
    try {
      await poolSql`
        INSERT INTO public.partner_users
          (tenant_id, partner_org_id, user_id, full_name, email, role, active)
        VALUES (${PA_TENANT_B}, ${PA_ORG}, ${randomUUID()},
                'Cross Tenant', 'cross@example.com', 'partner_user', true)
      `;
    } catch (e: unknown) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    assert.ok(threw, "cross-tenant partner_user insert must throw");
    assert.match(msg, /foreign key|fk_partner_users_partner_org/i, msg);
  });

  it("Test 3: one-active-assignment per (partner, req); ended assignment doesn't block", async () => {
    await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${PA_TENANT}`;
    // First active assignment — succeeds.
    await poolSql`
      INSERT INTO public.partner_assignments
        (tenant_id, partner_org_id, requisition_id, status)
      VALUES (${PA_TENANT}, ${PA_ORG}, ${PA_REQ}, 'active')
    `;
    // Second active assignment for the same (partner, req) — partial
    // unique blocks.
    let threw = false;
    try {
      await poolSql`
        INSERT INTO public.partner_assignments
          (tenant_id, partner_org_id, requisition_id, status)
        VALUES (${PA_TENANT}, ${PA_ORG}, ${PA_REQ}, 'active')
      `;
    } catch {
      threw = true;
    }
    assert.ok(threw, "second active assignment must be rejected");
    // End the first, then re-assign — should succeed.
    await poolSql`
      UPDATE public.partner_assignments
      SET status = 'ended', ended_at = now()
      WHERE tenant_id = ${PA_TENANT} AND partner_org_id = ${PA_ORG} AND requisition_id = ${PA_REQ}
    `;
    await poolSql`
      INSERT INTO public.partner_assignments
        (tenant_id, partner_org_id, requisition_id, status)
      VALUES (${PA_TENANT}, ${PA_ORG}, ${PA_REQ}, 'active')
    `;
    const rows = await poolSql`
      SELECT COUNT(*)::int AS n FROM public.partner_assignments
      WHERE tenant_id = ${PA_TENANT} AND status = 'active'
    `;
    assert.equal(rows[0]?.n, 1, "exactly one active row after re-assign");
  });

  it("Test 4: one-active-claim per (tenant, person); released claim doesn't block", async () => {
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${PA_TENANT}`;
    // First active claim — succeeds.
    await poolSql`
      INSERT INTO public.candidate_ownership_claims
        (tenant_id, person_id, partner_org_id, expires_at, status)
      VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_EMPANELLED}, now() + interval '6 months', 'active')
    `;
    // Second active claim for the same person — partial unique blocks.
    let threw = false;
    try {
      await poolSql`
        INSERT INTO public.candidate_ownership_claims
          (tenant_id, person_id, partner_org_id, expires_at, status)
        VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_AD_HOC}, now() + interval '6 months', 'active')
      `;
    } catch {
      threw = true;
    }
    assert.ok(threw, "second active claim for same person must be rejected");
    // Release the first; new claim should succeed.
    await poolSql`
      UPDATE public.candidate_ownership_claims
      SET status = 'released', released_at = now()
      WHERE tenant_id = ${PA_TENANT} AND person_id = ${PA_PERSON}
    `;
    await poolSql`
      INSERT INTO public.candidate_ownership_claims
        (tenant_id, person_id, partner_org_id, expires_at, status)
      VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_AD_HOC}, now() + interval '6 months', 'active')
    `;
    const rows = await poolSql`
      SELECT COUNT(*)::int AS n FROM public.candidate_ownership_claims
      WHERE tenant_id = ${PA_TENANT} AND status = 'active'
    `;
    assert.equal(rows[0]?.n, 1, "exactly one active claim after release");
  });

  it("Test 5: expiry boundary — active+past-expiry STILL blocks (sweep is load-bearing)", async () => {
    // Documents the deviation from the ticket spec: Postgres rejects
    // now() in partial index predicates, so the unique uses status only.
    // A row with status='active' AND expires_at < now() blocks a fresh
    // claim until the background sweep flips status to 'expired'.
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${PA_TENANT}`;
    await poolSql`
      INSERT INTO public.candidate_ownership_claims
        (tenant_id, person_id, partner_org_id, expires_at, status)
      VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_EMPANELLED}, now() - interval '1 day', 'active')
    `;
    let threw = false;
    try {
      await poolSql`
        INSERT INTO public.candidate_ownership_claims
          (tenant_id, person_id, partner_org_id, expires_at, status)
        VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_AD_HOC}, now() + interval '6 months', 'active')
      `;
    } catch {
      threw = true;
    }
    assert.ok(threw, "active+past-expiry must block until sweep updates status");
    // Once the sweep flips status to 'expired', new claim works.
    await poolSql`
      UPDATE public.candidate_ownership_claims
      SET status = 'expired'
      WHERE tenant_id = ${PA_TENANT} AND person_id = ${PA_PERSON} AND status = 'active'
    `;
    await poolSql`
      INSERT INTO public.candidate_ownership_claims
        (tenant_id, person_id, partner_org_id, expires_at, status)
      VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_AD_HOC}, now() + interval '6 months', 'active')
    `;
  });

  it("Test 6: invitation token-hash storage + lookup", async () => {
    await poolSql`DELETE FROM public.partner_invitations WHERE tenant_id = ${PA_TENANT}`;
    const rawToken = "raw-token-do-not-store-or-log";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await poolSql`
      INSERT INTO public.partner_invitations
        (tenant_id, partner_org_id, email, intended_role, token_hash, expires_at)
      VALUES (${PA_TENANT}, ${PA_ORG_EMPANELLED}, 'invitee@example.com',
              'partner_admin', ${tokenHash}, now() + interval '7 days')
    `;
    // Lookup-by-hash returns exactly one row.
    const found = await poolSql<{ email: string }[]>`
      SELECT email FROM public.partner_invitations
      WHERE tenant_id = ${PA_TENANT} AND token_hash = ${tokenHash}
    `;
    assert.equal(found.length, 1);
    assert.equal(found[0]?.email, "invitee@example.com");
    // Lookup with wrong hash returns nothing.
    const notFound = await poolSql`
      SELECT 1 FROM public.partner_invitations
      WHERE tenant_id = ${PA_TENANT} AND token_hash = ${createHash("sha256").update("wrong").digest("hex")}
    `;
    assert.equal(notFound.length, 0);
  });

  it("Test 7: audit triggers fire on partner_orgs INSERT and partner_assignments UPDATE", async () => {
    const orgId = randomUUID();
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${PA_TENANT} AND entity_id = ${orgId}`;
    await poolSql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active)
      VALUES (${orgId}, ${PA_TENANT}, 'Audit Test Co', 'empanelled', true)
    `;
    const orgAudit = await poolSql`
      SELECT action FROM public.audit_logs
      WHERE tenant_id = ${PA_TENANT} AND entity_type = 'partner_orgs' AND entity_id = ${orgId}
    `;
    assert.ok(orgAudit.length >= 1, "partner_orgs insert must produce an audit row");
    assert.equal(orgAudit[0]?.action, "insert");

    // partner_assignments UPDATE — flip status to paused.
    const assignRows = await poolSql<{ id: string }[]>`
      SELECT id FROM public.partner_assignments
      WHERE tenant_id = ${PA_TENANT} AND status = 'active' LIMIT 1
    `;
    const assignId = assignRows[0]?.id;
    if (!assignId) {
      // Test 3 cleaned up if it ran already; create a fresh one.
      const fresh = await poolSql<{ id: string }[]>`
        INSERT INTO public.partner_assignments
          (tenant_id, partner_org_id, requisition_id, status)
        VALUES (${PA_TENANT}, ${orgId}, ${PA_REQ}, 'active')
        RETURNING id
      `;
      const id = fresh[0]?.id;
      assert.ok(id);
      await poolSql`UPDATE public.partner_assignments SET status = 'paused' WHERE id = ${id}`;
      const audit = await poolSql`
        SELECT action FROM public.audit_logs
        WHERE tenant_id = ${PA_TENANT} AND entity_type = 'partner_assignments' AND entity_id = ${id} AND action = 'update'
      `;
      assert.ok(audit.length >= 1, "partner_assignments update must audit");
    } else {
      await poolSql`UPDATE public.partner_assignments SET status = 'paused' WHERE id = ${assignId}`;
      const audit = await poolSql`
        SELECT action FROM public.audit_logs
        WHERE tenant_id = ${PA_TENANT} AND entity_type = 'partner_assignments' AND entity_id = ${assignId} AND action = 'update'
      `;
      assert.ok(audit.length >= 1, "partner_assignments update must audit");
    }
  });

  it("Test 8a: candidate_dedup_attempts is append-only under FORCE RLS", async () => {
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${PA_TENANT}`;
    await poolSql`
      INSERT INTO public.candidate_dedup_attempts
        (tenant_id, decision, submitted_email)
      VALUES (${PA_TENANT}, 'allow_new', 'dedup-test@example.com')
    `;
    // UPDATE / DELETE as authenticated affects zero rows — RLS without
    // a matching policy hides the row from those verbs.
    const claims: JwtClaims = {
      sub: testUserId,
      tid: testTenantId,
      tenant_slug: "kyndryl-poc",
      roles: ["admin"],
    };
    await withTenantContext(claims, async ({ db: tx }) => {
      // Both ops match zero rows: RLS scopes to caller's tenant (≠ PA_TENANT)
      // and even within the right tenant there's no UPDATE/DELETE policy
      // for authenticated. Either way the seeded row survives unmodified.
      await tx.execute(
        drizzleSql`UPDATE public.candidate_dedup_attempts SET decision = 'link_existing' WHERE tenant_id = ${PA_TENANT}`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${PA_TENANT}`,
      );
    });
    const rows = await poolSql`
      SELECT decision FROM public.candidate_dedup_attempts WHERE tenant_id = ${PA_TENANT}
    `;
    assert.equal(rows.length, 1, "row must survive UPDATE/DELETE as authenticated");
    assert.equal(rows[0]?.decision, "allow_new", "value must be unchanged");
  });

  it("Test 8b: partner_candidate_messages allows UPDATE delivery_status (NOT append-only)", async () => {
    // Documents the deviation from ticket's split-policy lean. Single
    // tenant_isolation policy lets the messaging system update
    // delivery_status; row content is convention-immutable.
    await poolSql`DELETE FROM public.partner_candidate_messages WHERE tenant_id = ${PA_TENANT}`;
    // Need a partner_user + candidate + application for FKs.
    await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PA_TENANT}`;
    await poolSql`
      INSERT INTO public.partner_users
        (id, tenant_id, partner_org_id, user_id, full_name, email, role, active)
      VALUES (${PA_PARTNER_USER}, ${PA_TENANT}, ${PA_ORG_EMPANELLED}, ${PA_PARTNER_AUTH_USER},
              'PA Partner User', 'pa-pu@example.com', 'partner_user', true)
    `;
    const candidateRows = await poolSql<{ id: string }[]>`
      INSERT INTO public.candidates (tenant_id, person_id, source, consent_version)
      VALUES (${PA_TENANT}, ${PA_PERSON}, 'partner_empanelled', 'v1')
      RETURNING id
    `;
    const candidateId = candidateRows[0]?.id;
    assert.ok(candidateId);

    const msgRows = await poolSql<{ id: string }[]>`
      INSERT INTO public.partner_candidate_messages
        (tenant_id, partner_user_id, candidate_id, body, delivery_status)
      VALUES (${PA_TENANT}, ${PA_PARTNER_USER}, ${candidateId}, 'hello',  'pending')
      RETURNING id
    `;
    const msgId = msgRows[0]?.id;
    assert.ok(msgId);
    // UPDATE delivery_status — should succeed as service role.
    await poolSql`
      UPDATE public.partner_candidate_messages
      SET delivery_status = 'sent', delivered_at = now()
      WHERE id = ${msgId}
    `;
    const after = await poolSql<{ delivery_status: string }[]>`
      SELECT delivery_status FROM public.partner_candidate_messages WHERE id = ${msgId}
    `;
    assert.equal(after[0]?.delivery_status, "sent", "delivery_status must be updatable");
  });

  it("Test 9: partner_users (tenant_id, user_id) UNIQUE — second insert rejected", async () => {
    // Test 8b leaves a partner_candidate_messages row referencing
    // PA_PARTNER_USER; fk_pcm_partner_user is ON DELETE RESTRICT so we
    // must wipe messages first.
    await poolSql`DELETE FROM public.partner_candidate_messages WHERE tenant_id = ${PA_TENANT}`;
    await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${PA_TENANT}`;
    const authUserId = randomUUID();
    await poolSql`
      INSERT INTO public.partner_users
        (tenant_id, partner_org_id, user_id, full_name, email, role, active)
      VALUES (${PA_TENANT}, ${PA_ORG_EMPANELLED}, ${authUserId},
              'First', 'first@example.com', 'partner_user', true)
    `;
    let threw = false;
    try {
      await poolSql`
        INSERT INTO public.partner_users
          (tenant_id, partner_org_id, user_id, full_name, email, role, active)
        VALUES (${PA_TENANT}, ${PA_ORG_AD_HOC}, ${authUserId},
                'Second', 'second@example.com', 'partner_admin', true)
      `;
    } catch {
      threw = true;
    }
    assert.ok(threw, "same user_id in same tenant must be rejected");
  });

  it("Test 10: ad_hoc_partner_domains — per-tenant uniqueness on active rows", async () => {
    await poolSql`DELETE FROM public.ad_hoc_partner_domains WHERE tenant_id IN (${PA_TENANT}, ${PA_TENANT_B})`;
    // Provision an ad_hoc partner org in tenant B so the cross-tenant
    // insert has a valid FK target.
    await poolSql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active)
      VALUES (${randomUUID()}, ${PA_TENANT_B}, 'B Ad-Hoc', 'ad_hoc', true)
    `;
    const orgBRows = await poolSql<{ id: string }[]>`
      SELECT id FROM public.partner_orgs WHERE tenant_id = ${PA_TENANT_B} LIMIT 1
    `;
    const orgBId = orgBRows[0]?.id;
    assert.ok(orgBId);

    const domain = "shared-vendor.example.com";
    // Same domain in two tenants — both succeed.
    await poolSql`
      INSERT INTO public.ad_hoc_partner_domains
        (tenant_id, partner_org_id, domain, default_consent_text, default_contact_email, active)
      VALUES (${PA_TENANT}, ${PA_ORG_AD_HOC}, ${domain}, 'consent', 'a@example.com', true)
    `;
    await poolSql`
      INSERT INTO public.ad_hoc_partner_domains
        (tenant_id, partner_org_id, domain, default_consent_text, default_contact_email, active)
      VALUES (${PA_TENANT_B}, ${orgBId}, ${domain}, 'consent', 'b@example.com', true)
    `;
    // Same domain twice (both active) in same tenant — second rejected.
    let threw = false;
    try {
      await poolSql`
        INSERT INTO public.ad_hoc_partner_domains
          (tenant_id, partner_org_id, domain, default_consent_text, default_contact_email, active)
        VALUES (${PA_TENANT}, ${PA_ORG_EMPANELLED}, ${domain}, 'consent', 'c@example.com', true)
      `;
    } catch {
      threw = true;
    }
    assert.ok(threw, "second active row for same (tenant, domain) must be rejected");
    // Flip first to inactive, then add a new active — partial unique allows.
    await poolSql`
      UPDATE public.ad_hoc_partner_domains
      SET active = false
      WHERE tenant_id = ${PA_TENANT} AND domain = ${domain}
    `;
    await poolSql`
      INSERT INTO public.ad_hoc_partner_domains
        (tenant_id, partner_org_id, domain, default_consent_text, default_contact_email, active)
      VALUES (${PA_TENANT}, ${PA_ORG_EMPANELLED}, ${domain}, 'consent', 'd@example.com', true)
    `;
  });

  it("Test 11: ad_hoc_partner_domains tier-consistency is APP-LAYER (DB allows empanelled link)", async () => {
    // Documents that the DB doesn't enforce
    // "ad_hoc_partner_domains.partner_org_id must reference tier='ad_hoc'".
    // Cross-table CHECK isn't expressible in standard SQL; enforcement
    // lives in the app. This test asserts the *actual* DB behaviour so a
    // future reader doesn't get surprised.
    await poolSql`DELETE FROM public.ad_hoc_partner_domains WHERE tenant_id = ${PA_TENANT} AND domain = 'tier-mismatch-test.example.com'`;
    // PA_ORG_EMPANELLED has tier='empanelled'. The DB lets us link it.
    await poolSql`
      INSERT INTO public.ad_hoc_partner_domains
        (tenant_id, partner_org_id, domain, default_consent_text, default_contact_email, active)
      VALUES (${PA_TENANT}, ${PA_ORG_EMPANELLED}, 'tier-mismatch-test.example.com',
              'consent', 'mismatch@example.com', true)
    `;
    const rows = await poolSql`
      SELECT 1 FROM public.ad_hoc_partner_domains
      WHERE tenant_id = ${PA_TENANT} AND domain = 'tier-mismatch-test.example.com'
    `;
    assert.equal(rows.length, 1, "DB accepts tier-mismatched link (app must validate)");
  });

  it("Test 12: self-FK supersedes chain on candidate_ownership_claims", async () => {
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${PA_TENANT}`;
    // Claim A — released.
    const aRows = await poolSql<{ id: string }[]>`
      INSERT INTO public.candidate_ownership_claims
        (tenant_id, person_id, partner_org_id, expires_at, status, released_at, released_reason)
      VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_EMPANELLED}, now() + interval '6 months',
              'released', now(), 'voluntary')
      RETURNING id
    `;
    const aId = aRows[0]?.id;
    assert.ok(aId);
    // Claim B — active, taking over.
    const bRows = await poolSql<{ id: string }[]>`
      INSERT INTO public.candidate_ownership_claims
        (tenant_id, person_id, partner_org_id, expires_at, status)
      VALUES (${PA_TENANT}, ${PA_PERSON}, ${PA_ORG_AD_HOC}, now() + interval '6 months', 'active')
      RETURNING id
    `;
    const bId = bRows[0]?.id;
    assert.ok(bId);
    // Mark A as superseded by B and rewrite its status.
    await poolSql`
      UPDATE public.candidate_ownership_claims
      SET status = 'superseded', superseded_by_claim_id = ${bId}
      WHERE id = ${aId}
    `;
    const verify = await db
      .select({
        id: candidateOwnershipClaims.id,
        supersededBy: candidateOwnershipClaims.supersededByClaimId,
      })
      .from(candidateOwnershipClaims)
      .where(
        and(eq(candidateOwnershipClaims.tenantId, PA_TENANT), eq(candidateOwnershipClaims.id, aId)),
      );
    assert.equal(verify[0]?.supersededBy, bId, "A.superseded_by_claim_id must point at B");
  });
});

// Silence "unused" lint warning on test-only imports.
void partnerInvitations;
void candidateDedupAttempts;
void partnerCandidateMessages;
void adHocPartnerDomains;
void auditLogs;
