/**
 * P0.3 — ownership-claim lifecycle: the expiry sweep + the internal release.
 *
 * Two halves of the same state machine, tested together because the second is
 * meaningless without the first:
 *
 *   - The WORKER sweep (apps/workers/src/jobs/ownership-claim-sweep.ts) flips
 *     past-expiry ACTIVE claims to 'expired'. It is load-bearing, not hygiene:
 *     the partial unique index that guarantees one active claim per person has
 *     a status-only predicate (Postgres won't take now() in a partial index),
 *     so before this job existed an expired claim blocked that candidate's
 *     re-submission FOREVER. db-partner-a.test.ts Test 5 documents the
 *     blocking at the DB level; Test 2 here proves it end-to-end through
 *     partnerSubmitCandidate, and proves the sweep is what unblocks it.
 *   - releaseOwnershipClaim / listPartnerOrgClaims are the human half, on the
 *     internal partner-admin surface (admin / hr_ops).
 *
 * Worker-test convention: apps/workers has no vitest setup, so worker jobs are
 * tested from apps/api/test/ by importing the job's exported core over the
 * relative path — exactly what stage-stale-scan.test.ts and agent-ttl-scan
 * .test.ts do. The sweep's core takes the sql handle for that reason.
 *
 * Harness: the real appRouter via createCaller with two synthetic contexts —
 * an INTERNAL one (tenantId + roles + claims, so protectedProcedure opens
 * withTenantContext and RLS/audit behave as they do behind a JWT) and a
 * PARTNER one (a bare verified `sub`; partnerProcedure resolves org + tenant
 * from partner_users). Same as partner-admin.test.ts / partner-submission
 * .test.ts, whose fixtures Test 2 is modelled on.
 *
 * Cross-tenant caveat, deliberate: the sweep is service-role and global by
 * design (that IS the production posture), so it can flip ambient past-expiry
 * claims in other tenants. Assertions are therefore per-fixture-row, never
 * global counts, and every fixture lives in this file's own synthetic tenants.
 *
 * Tests run in file order and share fixtures (house convention): Test 2's
 * submission creates the ACTIVE claim Test 3 releases, and Test 3's release
 * creates the released row Test 4 reads back.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { resetStorageClient, getStorageClient } from "../src/lib/storage";
import { sweepExpiredOwnershipClaims } from "../../../apps/workers/src/jobs/ownership-claim-sweep.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

// a06 synth namespace (a02 partner-auth, a03 partner-submission, a04
// partner-admin, a05 partner-invite-accept). Valid v4-format UUIDs so they
// satisfy the procedures' z.string().uuid() OUTPUT validation.
const PC_TENANT = "00000000-0000-4000-8000-0000000a06a1";
const PC_TENANT_B = "00000000-0000-4000-8000-0000000a06a2";
const PC_BU = "00000000-0000-4000-8000-0000000a06c1";
const PC_MEMBERSHIP = "00000000-0000-4000-8000-0000000a06c2";
const PC_POSITION = "00000000-0000-4000-8000-0000000a06c3";
const PC_JD = "00000000-0000-4000-8000-0000000a06c4";
const PC_REQ_1 = "00000000-0000-4000-8000-0000000a06d1";
const PC_ORG_1 = "00000000-0000-4000-8000-0000000a06b1"; // the submitting partner
const PC_ORG_2 = "00000000-0000-4000-8000-0000000a06b2"; // owns the stale claim
const PC_ORG_B = "00000000-0000-4000-8000-0000000a06b3"; // in the OTHER tenant
const PC_PARTNER_USER_1 = "00000000-0000-4000-8000-0000000a06e1";

// Sweep fixtures — one person per claim, because the partial unique index
// allows only one ACTIVE claim per (tenant, person).
const PC_PERSON_PAST = "00000000-0000-4000-8000-0000000a06f1";
const PC_PERSON_FUTURE = "00000000-0000-4000-8000-0000000a06f2";
const PC_PERSON_RELEASED = "00000000-0000-4000-8000-0000000a06f3";
const PC_PERSON_EXPIRED = "00000000-0000-4000-8000-0000000a06f4";
const PC_CLAIM_PAST = "00000000-0000-4000-8000-0000000a0691";
const PC_CLAIM_FUTURE = "00000000-0000-4000-8000-0000000a0692";
const PC_CLAIM_RELEASED = "00000000-0000-4000-8000-0000000a0693";
const PC_CLAIM_EXPIRED = "00000000-0000-4000-8000-0000000a0694";

// Test 2's fixtures — created inside the test, AFTER Test 1's sweep, so the
// stale claim is genuinely stale when partnerSubmitCandidate looks at it.
const PC_PERSON_BLOCKED = "00000000-0000-4000-8000-0000000a06f5";
const PC_CLAIM_STALE = "00000000-0000-4000-8000-0000000a0695";

// The other tenant's live claim — the cross-tenant release probe.
const PC_PERSON_B = "00000000-0000-4000-8000-0000000a06f9";
const PC_CLAIM_B = "00000000-0000-4000-8000-0000000a0699";

const TENANT_SLUG = "synth-partner-claims";

// No auth.users FK on partner_users.user_id, so a random uuid is a legitimate
// partner identity (same reasoning as partner-auth.test.ts).
const PARTNER_AUTH_1 = randomUUID();

const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

const BLOCKED_EMAIL = "stale.claim@example.com";
const BLOCKED_PHONE = "+919845000123";
const CONSENT_VERSION = "partner-msa-v1-test";

let STORAGE_KEY: string;

const log = createLogger({ level: "error" });

/** Internal-staff caller: the ctx protectedProcedure would build from a JWT. */
function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: PC_TENANT,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: PC_TENANT, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-partner-claims-${randomUUID()}`,
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
    requestId: `test-partner-claims-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

interface ClaimRow {
  id: string;
  status: string;
  released_at: Date | null;
  released_reason: string | null;
}

async function claimById(id: string): Promise<ClaimRow | undefined> {
  const [row] = await poolSql<ClaimRow[]>`
    SELECT id, status::text AS status, released_at, released_reason
    FROM public.candidate_ownership_claims WHERE id = ${id}
  `;
  return row;
}

async function cleanup(): Promise<void> {
  for (const t of [PC_TENANT, PC_TENANT_B]) {
    await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidate_ownership_claims WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.applications WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${t}`;
    await poolSql`DELETE FROM public.persons WHERE tenant_id = ${t}`;
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

describe("P0.3 ownership-claim lifecycle (sweep + internal release)", () => {
  /** The claim partnerSubmitCandidate mints in Test 2; released in Test 3. */
  let createdClaimId: string;

  beforeAll(async () => {
    resetStorageClient();

    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(
        `P0.3 prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found. Run pnpm db:seed:test-users first.`,
      );
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PC_TENANT}, ${TENANT_SLUG}, 'Partner-Claims Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${PC_TENANT_B}, 'synth-partner-claims-b', 'Partner-Claims-B Synth', 'ap-northeast-1', 'active')`;

    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PC_BU}, ${PC_TENANT}, 'PC BU', 'pc-bu')`;
    // One membership, three personas: the gate reads ctx.roles (the JWT roles
    // claim), and this row's roles array is what such a JWT would carry.
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${PC_MEMBERSHIP}, ${PC_TENANT}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${PC_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${PC_POSITION}, ${PC_TENANT}, ${PC_BU}, 'Synth Claims Engineer', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${PC_JD}, ${PC_TENANT}, ${PC_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${PC_REQ_1}, ${PC_TENANT}, ${PC_POSITION}, ${PC_JD}, ${PC_MEMBERSHIP}, ${PC_MEMBERSHIP}, 'posted', true)`;

    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PC_ORG_1}, ${PC_TENANT}, 'Claimwell Staffing Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PC_ORG_2}, ${PC_TENANT}, 'Stale Claim Partners', 'ad_hoc', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${PC_ORG_B}, ${PC_TENANT_B}, 'Other-Tenant Partners', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PC_PARTNER_USER_1}, ${PC_TENANT}, ${PC_ORG_1}, ${PARTNER_AUTH_1}, 'Ravi Synth', 'ravi@claimwell.example', 'partner_admin', true)`;
    await poolSql`INSERT INTO public.partner_assignments (tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status) VALUES (${PC_TENANT}, ${PC_ORG_1}, ${PC_REQ_1}, ${PC_MEMBERSHIP}, 'active')`;

    // ── Sweep fixtures, all owned by ORG_1 so Test 4 can read a real history.
    // claimed_at is staggered so "newest first" is a meaningful assertion.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_PAST}, ${PC_TENANT}, 'Past Expiry', 'past.expiry@example.com', 'past.expiry@example.com', '+919800000101', '919800000101')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_FUTURE}, ${PC_TENANT}, 'Future Expiry', 'future.expiry@example.com', 'future.expiry@example.com', '+919800000102', '919800000102')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_RELEASED}, ${PC_TENANT}, 'Already Released', 'already.released@example.com', 'already.released@example.com', '+919800000103', '919800000103')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_EXPIRED}, ${PC_TENANT}, 'Already Expired', 'already.expired@example.com', 'already.expired@example.com', '+919800000104', '919800000104')`;

    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status) VALUES (${PC_CLAIM_PAST}, ${PC_TENANT}, ${PC_PERSON_PAST}, ${PC_ORG_1}, now() - interval '91 days', now() - interval '1 day', 'active')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status) VALUES (${PC_CLAIM_FUTURE}, ${PC_TENANT}, ${PC_PERSON_FUTURE}, ${PC_ORG_1}, now() - interval '10 days', now() + interval '80 days', 'active')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status, released_at, released_reason) VALUES (${PC_CLAIM_RELEASED}, ${PC_TENANT}, ${PC_PERSON_RELEASED}, ${PC_ORG_1}, now() - interval '120 days', now() - interval '30 days', 'released', now() - interval '40 days', 'seeded release')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status) VALUES (${PC_CLAIM_EXPIRED}, ${PC_TENANT}, ${PC_PERSON_EXPIRED}, ${PC_ORG_1}, now() - interval '200 days', now() - interval '110 days', 'expired')`;

    // The other tenant's live claim. Future-dated so this file's own sweeps
    // (which are global by design) leave it alone.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_B}, ${PC_TENANT_B}, 'Other Tenant Person', 'other.tenant@example.com', 'other.tenant@example.com', '+919800000199', '919800000199')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status) VALUES (${PC_CLAIM_B}, ${PC_TENANT_B}, ${PC_PERSON_B}, ${PC_ORG_B}, now(), now() + interval '90 days', 'active')`;

    const cvBuffer = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${PC_TENANT}-p03.docx`;
    await getStorageClient().put(STORAGE_KEY, cvBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
    if (STORAGE_KEY) {
      try {
        await getStorageClient().delete(STORAGE_KEY);
      } catch {
        // best-effort
      }
    }
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: the sweep expires past-expiry ACTIVE claims and touches nothing else", async () => {
    const flipped = await sweepExpiredOwnershipClaims(poolSql);
    // Global count (the sweep is cross-tenant on purpose), so the only safe
    // assertion on it is that our row was in the batch.
    assert.ok(flipped >= 1, `at least this file's stale claim was flipped (got ${flipped})`);

    const past = await claimById(PC_CLAIM_PAST);
    assert.equal(past?.status, "expired", "active + past expires_at → expired");
    assert.equal(past?.released_at, null, "expiry is not a release — released_at stays null");
    assert.equal(past?.released_reason, null, "…and no reason is invented");

    const future = await claimById(PC_CLAIM_FUTURE);
    assert.equal(future?.status, "active", "a live window is untouched");

    const released = await claimById(PC_CLAIM_RELEASED);
    assert.equal(released?.status, "released", "a released row stays released");
    assert.equal(
      released?.released_reason,
      "seeded release",
      "the sweep must not rewrite a release it didn't make",
    );

    const alreadyExpired = await claimById(PC_CLAIM_EXPIRED);
    assert.equal(alreadyExpired?.status, "expired", "an already-expired row stays expired");

    // Idempotent: a second pass has nothing of ours left to do.
    await sweepExpiredOwnershipClaims(poolSql);
    assert.equal((await claimById(PC_CLAIM_PAST))?.status, "expired", "still expired");
    assert.equal((await claimById(PC_CLAIM_FUTURE))?.status, "active", "still active");
  });

  it("Test 2: the bug — a stale claim blocks resubmission until the sweep runs", async () => {
    // A person owned by ORG_2 on a claim whose window closed yesterday but
    // whose status still says 'active' (exactly the state the sweep exists to
    // reconcile — and the state every claim reached before this ticket).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PC_PERSON_BLOCKED}, ${PC_TENANT}, 'Stale Claim Candidate', ${BLOCKED_EMAIL}, ${BLOCKED_EMAIL}, ${BLOCKED_PHONE}, '919845000123')`;
    await poolSql`INSERT INTO public.candidate_ownership_claims (id, tenant_id, person_id, partner_org_id, claimed_at, expires_at, status) VALUES (${PC_CLAIM_STALE}, ${PC_TENANT}, ${PC_PERSON_BLOCKED}, ${PC_ORG_2}, now() - interval '95 days', now() - interval '5 days', 'active')`;

    const partner = makePartnerCaller(PARTNER_AUTH_1);
    const input = {
      requisitionId: PC_REQ_1,
      resumeUploadKey: STORAGE_KEY,
      candidate: {
        fullName: "Stale Claim Candidate",
        email: BLOCKED_EMAIL,
        phone: BLOCKED_PHONE,
        locationCountry: "IN",
      },
      consentAttested: true as const,
      ownershipAcknowledged: true as const,
      consentVersion: CONSENT_VERSION,
    };

    // BEFORE the sweep: the expired-but-active claim still blocks. This is the
    // latent bug — without the sweep this candidate is unsubmittable forever.
    const blocked = await partner.partnerSubmitCandidate(input);
    assert.equal(blocked.outcome, "duplicate_blocked", "stale active claim blocks the submission");

    // AFTER the sweep: the window is honestly closed and the candidate is free.
    const flipped = await sweepExpiredOwnershipClaims(poolSql);
    assert.ok(flipped >= 1, `the stale claim was flipped (got ${flipped})`);
    assert.equal((await claimById(PC_CLAIM_STALE))?.status, "expired", "stale claim now expired");

    const created = await partner.partnerSubmitCandidate(input);
    assert.equal(created.outcome, "created", "after the sweep the same submission goes through");
    if (created.outcome !== "created") return;
    assert.equal(created.personId, PC_PERSON_BLOCKED, "the SAME person, re-claimed (not a dupe)");
    createdClaimId = created.claimId;

    // Exactly one active claim for the person, now owned by ORG_1.
    const active = await poolSql<{ id: string; partner_org_id: string }[]>`
      SELECT id, partner_org_id FROM public.candidate_ownership_claims
      WHERE tenant_id = ${PC_TENANT} AND person_id = ${PC_PERSON_BLOCKED} AND status = 'active'
    `;
    assert.equal(active.length, 1, "exactly one active claim after the re-claim");
    assert.equal(active[0]?.partner_org_id, PC_ORG_1, "ownership moved to the new submitter");
  });

  it("Test 3: releaseOwnershipClaim — gating, tenant isolation, and the release itself", async () => {
    const admin = makeInternalCaller(["admin"]);

    // Role gating: recruiter is not partner administration.
    await expectCode(
      () =>
        makeInternalCaller(["recruiter"]).releaseOwnershipClaim({
          claimId: createdClaimId,
          reason: "recruiter should not be able to do this",
        }),
      "FORBIDDEN",
      "recruiter releaseOwnershipClaim",
    );
    assert.equal(
      (await claimById(createdClaimId))?.status,
      "active",
      "the FORBIDDEN attempt changed nothing",
    );

    // Tenant isolation: another tenant's ACTIVE claim is simply absent.
    await expectCode(
      () => admin.releaseOwnershipClaim({ claimId: PC_CLAIM_B, reason: "cross-tenant probe" }),
      "NOT_FOUND",
      "cross-tenant releaseOwnershipClaim",
    );
    const otherTenantClaim = await claimById(PC_CLAIM_B);
    assert.equal(otherTenantClaim?.status, "active", "the other tenant's claim is untouched");
    assert.equal(otherTenantClaim?.released_at, null, "…and unreleased");

    // The release itself, by hr_ops (it runs the vendor relationship).
    const before = Date.now();
    const out = await makeInternalCaller(["hr_ops"]).releaseOwnershipClaim({
      claimId: createdClaimId,
      reason: "  Partner confirmed by email they are standing down.  ",
    });
    assert.equal(out.claimId, createdClaimId);
    const releasedAtMs = new Date(out.releasedAt).getTime();
    assert.ok(
      Math.abs(releasedAtMs - before) < 60_000,
      `releasedAt is stamped now (off by ${releasedAtMs - before}ms)`,
    );

    const row = await claimById(createdClaimId);
    assert.equal(row?.status, "released", "status flipped to released");
    const persistedReleasedAt = row?.released_at;
    assert.ok(persistedReleasedAt, "released_at persisted");
    assert.equal(
      new Date(persistedReleasedAt).toISOString(),
      new Date(out.releasedAt).toISOString(),
      "the returned stamp is the persisted one",
    );
    assert.equal(
      row?.released_reason,
      "Partner confirmed by email they are standing down.",
      "reason persisted, trimmed",
    );

    // Releasing an already-released claim → NOT_FOUND (only ACTIVE claims can
    // be released; a second release must not overwrite the dispute record).
    await expectCode(
      () => admin.releaseOwnershipClaim({ claimId: createdClaimId, reason: "second attempt" }),
      "NOT_FOUND",
      "release of an already-released claim",
    );
    assert.equal(
      (await claimById(createdClaimId))?.released_reason,
      "Partner confirmed by email they are standing down.",
      "the original reason survives the rejected second release",
    );

    // An expired claim is not releasable either — same answer.
    await expectCode(
      () => admin.releaseOwnershipClaim({ claimId: PC_CLAIM_STALE, reason: "expired attempt" }),
      "NOT_FOUND",
      "release of an expired claim",
    );

    // The freed person is immediately claimable again: nothing active is left.
    const stillActive = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.candidate_ownership_claims
      WHERE tenant_id = ${PC_TENANT} AND person_id = ${PC_PERSON_BLOCKED} AND status = 'active'
    `;
    assert.equal(stillActive[0]?.n, 0, "no active claim holds the person after the release");
  });

  it("Test 4: listPartnerOrgClaims — full history, newest first, tenant-scoped", async () => {
    const admin = makeInternalCaller(["admin"]);
    const { items } = await admin.listPartnerOrgClaims({ partnerOrgId: PC_ORG_1 });

    // ORG_1's four seeded claims plus the one it won in Test 2.
    const ids = items.map((i) => i.claimId);
    assert.equal(items.length, 5, `exactly ORG_1's claims (got ${ids.join(", ")})`);
    for (const id of [
      PC_CLAIM_PAST,
      PC_CLAIM_FUTURE,
      PC_CLAIM_RELEASED,
      PC_CLAIM_EXPIRED,
      createdClaimId,
    ]) {
      assert.ok(ids.includes(id), `claim ${id} is listed`);
    }
    // ORG_2's stale claim belongs to another org — it must not leak in.
    assert.ok(!ids.includes(PC_CLAIM_STALE), "another org's claim is not listed");

    // Newest first, by claimed_at.
    const claimedAts = items.map((i) => new Date(i.claimedAt).getTime());
    const descending = [...claimedAts].sort((a, b) => b - a);
    assert.deepEqual(claimedAts, descending, "ordered newest first");

    // The released row carries its stamps + reason (the dispute record).
    const releasedRow = items.find((i) => i.claimId === createdClaimId);
    assert.ok(releasedRow, "the just-released claim is in the list");
    assert.equal(releasedRow.status, "released");
    assert.ok(releasedRow.releasedAt, "releasedAt exposed");
    assert.equal(
      releasedRow.releasedReason,
      "Partner confirmed by email they are standing down.",
      "reason exposed",
    );
    assert.equal(
      releasedRow.candidateName,
      "Stale Claim Candidate",
      "the person's display name is resolved",
    );

    // Non-active history is present, not filtered away.
    const statuses = new Set(items.map((i) => i.status));
    assert.ok(statuses.has("active"), "the live claim is there");
    assert.ok(statuses.has("expired"), "expired history is there");
    assert.ok(statuses.has("released"), "released history is there");
    const expiredRow = items.find((i) => i.claimId === PC_CLAIM_PAST);
    assert.equal(expiredRow?.status, "expired", "the swept row reads back as expired");
    assert.equal(expiredRow?.releasedAt, null, "an expired claim has no release stamps");

    // hr_ops can read too; recruiter cannot.
    const asHrOps = await makeInternalCaller(["hr_ops"]).listPartnerOrgClaims({
      partnerOrgId: PC_ORG_2,
    });
    assert.equal(asHrOps.items.length, 1, "ORG_2 holds only its stale claim");
    assert.equal(asHrOps.items[0]?.claimId, PC_CLAIM_STALE);
    assert.equal(asHrOps.items[0]?.status, "expired", "which the sweep expired");
    await expectCode(
      () => makeInternalCaller(["recruiter"]).listPartnerOrgClaims({ partnerOrgId: PC_ORG_1 }),
      "FORBIDDEN",
      "recruiter listPartnerOrgClaims",
    );

    // Another tenant's org → NOT_FOUND, exactly as getPartnerOrg answers.
    await expectCode(
      () => admin.listPartnerOrgClaims({ partnerOrgId: PC_ORG_B }),
      "NOT_FOUND",
      "cross-tenant listPartnerOrgClaims",
    );
  });
});
