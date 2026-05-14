/**
 * DB-APPROVAL integration verification.
 *
 * Lives in its own file because tenant-context.test.ts has grown to
 * 35 tests / 1700+ lines and absorbing 10 more would push it past the
 * point of single-file readability. Bootstrap (Supabase auth, test
 * user) duplicates intentionally — that is the cost of the split.
 *
 * Test fixtures live in the test tenant (testTenantId from the FND-15b
 * test user) plus a synthetic second tenant for cross-tenant isolation
 * checks. All entities use hex-only UUID suffixes with a `dba` namespace.
 *
 * Module-scope pre-cleanup wipes leftover rows from aborted prior runs
 * before the first test sets up its chain.
 */

import "../src/bootstrap";

import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import {
  sql as poolSql,
  withTenantContext,
  approvalMatrices,
  approvalChains,
  approvalRequests,
  approvalDecisions,
  type ApprovalSubjectType,
  type JwtClaims,
} from "@hireops/db";
import { eq } from "drizzle-orm";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

// Own-tenant fixtures (testTenantId).
const DBAP_MATRIX_ID = "00000000-0000-0000-0000-0000dbaa0001";
const DBAP_CHAIN_ID = "00000000-0000-0000-0000-0000dbaa0002";
const DBAP_REQUEST_PRIMARY_ID = "00000000-0000-0000-0000-0000dbaa0003";
const DBAP_REQUEST_PARTIAL_A_ID = "00000000-0000-0000-0000-0000dbaa0004";
const DBAP_REQUEST_PARTIAL_B_ID = "00000000-0000-0000-0000-0000dbaa0005";
const DBAP_REQUEST_PARTIAL_C_ID = "00000000-0000-0000-0000-0000dbaa0006";
const DBAP_REQUEST_VARS_ID = "00000000-0000-0000-0000-0000dbaa0007";
const DBAP_REQUEST_WD_ID = "00000000-0000-0000-0000-0000dbaa0008";

// One request per subject_type for the polymorphism test.
const DBAP_REQUEST_POLY_HC_ID = "00000000-0000-0000-0000-0000dbaa0009";
const DBAP_REQUEST_POLY_REQ_ID = "00000000-0000-0000-0000-0000dbaa000a";
const DBAP_REQUEST_POLY_JD_ID = "00000000-0000-0000-0000-0000dbaa000b";
const DBAP_REQUEST_POLY_OF_ID = "00000000-0000-0000-0000-0000dbaa000c";

// Opaque subject ids (not FK'd anywhere).
const DBAP_SUBJECT_PRIMARY = "00000000-0000-0000-0000-0000dbab0001";
const DBAP_SUBJECT_PARTIAL = "00000000-0000-0000-0000-0000dbab0002";
const DBAP_SUBJECT_VARS = "00000000-0000-0000-0000-0000dbab0003";
const DBAP_SUBJECT_WD = "00000000-0000-0000-0000-0000dbab0004";
const DBAP_SUBJECT_POLY_HC = "00000000-0000-0000-0000-0000dbab0005";
const DBAP_SUBJECT_POLY_REQ = "00000000-0000-0000-0000-0000dbab0006";
const DBAP_SUBJECT_POLY_JD = "00000000-0000-0000-0000-0000dbab0007";
const DBAP_SUBJECT_POLY_OF = "00000000-0000-0000-0000-0000dbab0008";

// Decisions used by individual tests.
const DBAP_DECISION_AUDIT_ID = "00000000-0000-0000-0000-0000dbac0001";
const DBAP_DECISION_WD_ID = "00000000-0000-0000-0000-0000dbac0002";

// Synth tenant + parallel chain for cross-tenant isolation tests.
const DBAP_SYNTH_TENANT_ID = "00000000-0000-0000-0000-0000dbad0001";
const DBAP_SYNTH_MEMBERSHIP_ID = "00000000-0000-0000-0000-0000dbad0002";
const DBAP_SYNTH_MATRIX_ID = "00000000-0000-0000-0000-0000dbad0003";
const DBAP_SYNTH_CHAIN_ID = "00000000-0000-0000-0000-0000dbad0004";
const DBAP_SYNTH_REQUEST_ID = "00000000-0000-0000-0000-0000dbad0005";
const DBAP_SYNTH_DECISION_ID = "00000000-0000-0000-0000-0000dbad0006";
const DBAP_SYNTH_SUBJECT_ID = "00000000-0000-0000-0000-0000dbad0007";

const ALL_REQUEST_IDS = [
  DBAP_REQUEST_PRIMARY_ID,
  DBAP_REQUEST_PARTIAL_A_ID,
  DBAP_REQUEST_PARTIAL_B_ID,
  DBAP_REQUEST_PARTIAL_C_ID,
  DBAP_REQUEST_VARS_ID,
  DBAP_REQUEST_WD_ID,
  DBAP_REQUEST_POLY_HC_ID,
  DBAP_REQUEST_POLY_REQ_ID,
  DBAP_REQUEST_POLY_JD_ID,
  DBAP_REQUEST_POLY_OF_ID,
];

const ALL_AUDIT_ENTITY_IDS = [
  ...ALL_REQUEST_IDS,
  DBAP_MATRIX_ID,
  DBAP_CHAIN_ID,
  DBAP_SYNTH_REQUEST_ID,
  DBAP_SYNTH_MATRIX_ID,
  DBAP_SYNTH_CHAIN_ID,
];

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`Failed to sign in test user: ${error?.message}`);
  }
  return data.session.access_token;
}

async function run(): Promise<void> {
  console.log("DB-APPROVAL integration tests starting...\n");

  // Pre-cleanup. Order matters — children before parents. The synth
  // tenant CASCADE-deletes its mirror chain; explicit deletes here only
  // wipe own-tenant rows.
  await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ANY(${ALL_AUDIT_ENTITY_IDS}::uuid[])`;
  await poolSql`DELETE FROM public.approval_decisions WHERE id IN (${DBAP_DECISION_AUDIT_ID}, ${DBAP_DECISION_WD_ID})`;
  await poolSql`DELETE FROM public.approval_decisions WHERE request_id = ANY(${ALL_REQUEST_IDS}::uuid[])`;
  await poolSql`DELETE FROM public.approval_requests WHERE id = ANY(${ALL_REQUEST_IDS}::uuid[])`;
  await poolSql`DELETE FROM public.approval_chains WHERE id = ${DBAP_CHAIN_ID}`;
  await poolSql`DELETE FROM public.approval_matrices WHERE id = ${DBAP_MATRIX_ID}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${DBAP_SYNTH_TENANT_ID}`;

  const jwt = await getTestJwt();
  const decodedClaims = decodeJwt(jwt) as JwtClaims;
  const testUserId = decodedClaims.sub!;
  const testTenantId = decodedClaims.tid!;

  const [membership] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships
    WHERE user_id = ${testUserId} AND tenant_id = ${testTenantId} LIMIT 1
  `;
  if (!membership) throw new Error("test user has no membership");
  const testMembershipId = membership.id;

  // === Test 1: shared own-tenant chain setup (used by most tests) ===
  // Own-tenant matrix + chain + primary request. Each subsequent test
  // may insert/mutate its own request rows but reuses these.
  await poolSql`
    INSERT INTO public.approval_matrices
      (id, tenant_id, subject_type, name, rules, effective_from, effective_to, created_by_membership_id)
    VALUES (
      ${DBAP_MATRIX_ID},
      ${testTenantId},
      'requisition',
      'DB-APPROVAL Test Matrix',
      ${JSON.stringify({ steps: [{ approver_kind: "role", approver_ref: "hiring_manager", required: true }] })},
      '2026-01-01T00:00:00Z',
      '2027-01-01T00:00:00Z',
      ${testMembershipId}
    )
  `;
  await poolSql`
    INSERT INTO public.approval_chains
      (id, tenant_id, matrix_id, matrix_version_snapshot, resolved_steps)
    VALUES (
      ${DBAP_CHAIN_ID},
      ${testTenantId},
      ${DBAP_MATRIX_ID},
      ${JSON.stringify({ steps: [{ approver_kind: "role", approver_ref: "hiring_manager" }] })},
      ${JSON.stringify([{ step_index: 0, approver_kind: "membership", approver_ref: testMembershipId, required: true, order_index: 0 }])}
    )
  `;
  await poolSql`
    INSERT INTO public.approval_requests
      (id, tenant_id, chain_id, subject_type, subject_id, status, requested_by_membership_id, context)
    VALUES (
      ${DBAP_REQUEST_PRIMARY_ID},
      ${testTenantId},
      ${DBAP_CHAIN_ID},
      'requisition',
      ${DBAP_SUBJECT_PRIMARY},
      'pending',
      ${testMembershipId},
      ${JSON.stringify({ grade: "L5", cost: 1200000 })}
    )
  `;

  // === Test 1: tenant isolation across matrices / chains / requests / decisions ===
  // Synth chain.
  await poolSql`
    INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
    VALUES (${DBAP_SYNTH_TENANT_ID}, 'synth-db-approval', 'Synth DB-Approval', 'ap-northeast-1', 'active')
  `;
  await poolSql`
    INSERT INTO public.tenant_user_memberships
      (id, user_id, tenant_id, roles, status, accepted_at)
    VALUES (${DBAP_SYNTH_MEMBERSHIP_ID}, ${testUserId}, ${DBAP_SYNTH_TENANT_ID}, ARRAY['admin']::tenant_role[], 'active', now())
  `;
  await poolSql`
    INSERT INTO public.approval_matrices
      (id, tenant_id, subject_type, name, rules, effective_from)
    VALUES (
      ${DBAP_SYNTH_MATRIX_ID},
      ${DBAP_SYNTH_TENANT_ID},
      'requisition',
      'Synth matrix',
      ${JSON.stringify({ steps: [] })},
      '2026-01-01T00:00:00Z'
    )
  `;
  await poolSql`
    INSERT INTO public.approval_chains
      (id, tenant_id, matrix_id, matrix_version_snapshot, resolved_steps)
    VALUES (
      ${DBAP_SYNTH_CHAIN_ID},
      ${DBAP_SYNTH_TENANT_ID},
      ${DBAP_SYNTH_MATRIX_ID},
      ${JSON.stringify({ steps: [] })},
      ${JSON.stringify([])}
    )
  `;
  await poolSql`
    INSERT INTO public.approval_requests
      (id, tenant_id, chain_id, subject_type, subject_id, status)
    VALUES (
      ${DBAP_SYNTH_REQUEST_ID},
      ${DBAP_SYNTH_TENANT_ID},
      ${DBAP_SYNTH_CHAIN_ID},
      'requisition',
      ${DBAP_SYNTH_SUBJECT_ID},
      'pending'
    )
  `;
  await poolSql`
    INSERT INTO public.approval_decisions
      (id, tenant_id, request_id, step_index, outcome, approver_membership_id, decided_at)
    VALUES (
      ${DBAP_SYNTH_DECISION_ID},
      ${DBAP_SYNTH_TENANT_ID},
      ${DBAP_SYNTH_REQUEST_ID},
      0,
      'approved',
      ${DBAP_SYNTH_MEMBERSHIP_ID},
      now()
    )
  `;

  {
    const view = await withTenantContext(decodedClaims, async ({ db }) => {
      const m = await db.select().from(approvalMatrices);
      const c = await db.select().from(approvalChains);
      const r = await db.select().from(approvalRequests);
      const d = await db.select().from(approvalDecisions);
      return { m, c, r, d };
    });
    assert.ok(
      view.m.find((x) => x.id === DBAP_MATRIX_ID),
      "own matrix visible",
    );
    assert.equal(
      view.m.find((x) => x.id === DBAP_SYNTH_MATRIX_ID),
      undefined,
      "synth matrix hidden",
    );
    assert.ok(
      view.c.find((x) => x.id === DBAP_CHAIN_ID),
      "own chain visible",
    );
    assert.equal(
      view.c.find((x) => x.id === DBAP_SYNTH_CHAIN_ID),
      undefined,
      "synth chain hidden",
    );
    assert.ok(
      view.r.find((x) => x.id === DBAP_REQUEST_PRIMARY_ID),
      "own request visible",
    );
    assert.equal(
      view.r.find((x) => x.id === DBAP_SYNTH_REQUEST_ID),
      undefined,
      "synth request hidden",
    );
    assert.equal(
      view.d.find((x) => x.id === DBAP_SYNTH_DECISION_ID),
      undefined,
      "synth decision hidden",
    );
    console.log("  ✓ tenant isolation across matrices/chains/requests/decisions");
  }

  // === Test 2: compound FK rejects cross-tenant chain reference on a request ===
  {
    // Use a never-seen subject_id so we don't trip the partial unique
    // before the FK check fires.
    const FK_PROBE_SUBJECT = "00000000-0000-0000-0000-0000dbab0099";
    let threw = false;
    let errMsg = "";
    try {
      await poolSql`
        INSERT INTO public.approval_requests
          (tenant_id, chain_id, subject_type, subject_id, status)
        VALUES (${testTenantId}, ${DBAP_SYNTH_CHAIN_ID}, 'requisition', ${FK_PROBE_SUBJECT}, 'pending')
      `;
    } catch (err: unknown) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(threw, "cross-tenant chain reference should throw FK violation");
    assert.match(errMsg, /foreign key|fk_approval_requests_chain/i, `unexpected: ${errMsg}`);
    console.log("  ✓ compound FK rejects cross-tenant chain on approval_requests");
  }

  // === Test 3: one pending request per subject (partial unique) ===
  {
    // First request against subject_partial — accepted.
    await poolSql`
      INSERT INTO public.approval_requests
        (id, tenant_id, chain_id, subject_type, subject_id, status)
      VALUES (${DBAP_REQUEST_PARTIAL_A_ID}, ${testTenantId}, ${DBAP_CHAIN_ID}, 'requisition', ${DBAP_SUBJECT_PARTIAL}, 'pending')
    `;
    // Second pending request against the SAME subject — should fail the
    // partial unique index.
    let threw = false;
    let errMsg = "";
    try {
      await poolSql`
        INSERT INTO public.approval_requests
          (id, tenant_id, chain_id, subject_type, subject_id, status)
        VALUES (${DBAP_REQUEST_PARTIAL_B_ID}, ${testTenantId}, ${DBAP_CHAIN_ID}, 'requisition', ${DBAP_SUBJECT_PARTIAL}, 'pending')
      `;
    } catch (err: unknown) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(threw, "second pending request should be rejected");
    assert.match(
      errMsg,
      /uniq_approval_requests_one_pending_per_subject|duplicate key/i,
      `unexpected: ${errMsg}`,
    );

    // Move the first one to a terminal status, then a fresh pending
    // request against the same subject is accepted.
    await poolSql`
      UPDATE public.approval_requests SET status = 'cancelled', decided_at = now()
      WHERE id = ${DBAP_REQUEST_PARTIAL_A_ID}
    `;
    await poolSql`
      INSERT INTO public.approval_requests
        (id, tenant_id, chain_id, subject_type, subject_id, status)
      VALUES (${DBAP_REQUEST_PARTIAL_C_ID}, ${testTenantId}, ${DBAP_CHAIN_ID}, 'requisition', ${DBAP_SUBJECT_PARTIAL}, 'pending')
    `;
    const survivors = await poolSql<{ id: string; status: string }[]>`
      SELECT id, status FROM public.approval_requests
      WHERE tenant_id = ${testTenantId} AND subject_id = ${DBAP_SUBJECT_PARTIAL}
      ORDER BY created_at
    `;
    assert.equal(survivors.length, 2);
    assert.equal(survivors[0]?.status, "cancelled");
    assert.equal(survivors[1]?.status, "pending");
    console.log(
      "  ✓ partial unique enforces one-pending-per-subject; terminal lets a fresh one through",
    );
  }

  // === Test 4: approver XOR CHECK on approval_decisions ===
  {
    // Neither → rejected.
    let neitherThrew = false;
    try {
      await poolSql`
        INSERT INTO public.approval_decisions
          (tenant_id, request_id, step_index, outcome)
        VALUES (${testTenantId}, ${DBAP_REQUEST_PRIMARY_ID}, 0, 'approved')
      `;
    } catch {
      neitherThrew = true;
    }
    assert.ok(neitherThrew, "INSERT with neither approver field should throw");

    // Both → rejected.
    let bothThrew = false;
    let bothErr = "";
    try {
      await poolSql`
        INSERT INTO public.approval_decisions
          (tenant_id, request_id, step_index, outcome, approver_membership_id, approver_external_ref)
        VALUES (${testTenantId}, ${DBAP_REQUEST_PRIMARY_ID}, 0, 'approved', ${testMembershipId}, 'WD-12345')
      `;
    } catch (err: unknown) {
      bothThrew = true;
      bothErr = err instanceof Error ? err.message : String(err);
    }
    assert.ok(bothThrew, "INSERT with both approver fields should throw");
    assert.match(
      bothErr,
      /approval_decisions_approver_xor_check|check constraint/i,
      `unexpected: ${bothErr}`,
    );

    // Exactly one (membership) → accepted.
    await poolSql`
      INSERT INTO public.approval_decisions
        (tenant_id, request_id, step_index, outcome, approver_membership_id)
      VALUES (${testTenantId}, ${DBAP_REQUEST_PRIMARY_ID}, 0, 'approved', ${testMembershipId})
    `;
    const got = await poolSql<{ id: string }[]>`
      SELECT id FROM public.approval_decisions
      WHERE request_id = ${DBAP_REQUEST_PRIMARY_ID}
    `;
    assert.equal(got.length, 1, "single-approver insert accepted");
    console.log("  ✓ CHECK constraint enforces approver XOR (neither / both / exactly one)");
  }

  // === Test 5: approval_decisions append-only ===
  {
    const [decision] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.approval_decisions
      WHERE request_id = ${DBAP_REQUEST_PRIMARY_ID} LIMIT 1
    `;
    assert.ok(decision, "decision row exists from prior test");
    const targetId = decision.id;

    const updated = await withTenantContext(decodedClaims, async ({ db }) => {
      return db
        .update(approvalDecisions)
        .set({ comment: "tampered" })
        .where(eq(approvalDecisions.id, targetId))
        .returning();
    });
    assert.equal(updated.length, 0, "UPDATE blocked under FORCE RLS (no UPDATE policy)");

    const deleted = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.delete(approvalDecisions).where(eq(approvalDecisions.id, targetId)).returning();
    });
    assert.equal(deleted.length, 0, "DELETE blocked under FORCE RLS (no DELETE policy)");

    const [reread] = await poolSql<{ comment: string | null }[]>`
      SELECT comment FROM public.approval_decisions WHERE id = ${targetId}
    `;
    assert.ok(reread, "row still present");
    assert.notEqual(reread.comment, "tampered", "comment unchanged");
    console.log("  ✓ approval_decisions append-only enforced via split RLS policies");
  }

  // === Test 6: audit trigger fires on matrices / chains / requests, NOT decisions ===
  {
    const m = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs
      WHERE entity_type = 'approval_matrices' AND entity_id = ${DBAP_MATRIX_ID}
    `;
    const c = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs
      WHERE entity_type = 'approval_chains' AND entity_id = ${DBAP_CHAIN_ID}
    `;
    const r = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs
      WHERE entity_type = 'approval_requests' AND entity_id = ${DBAP_REQUEST_PRIMARY_ID}
    `;
    const d = await poolSql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM public.audit_logs
      WHERE entity_type = 'approval_decisions'
    `;
    // Use .some(insert) rather than m[0]: a leftover 'delete' audit row from
    // a prior run's teardown can land before the current run's insert row
    // and there's no ORDER BY here.
    assert.ok(
      m.some((row) => row.action === "insert"),
      "matrix insert audited",
    );
    assert.ok(
      c.some((row) => row.action === "insert"),
      "chain insert audited",
    );
    assert.ok(
      r.some((row) => row.action === "insert"),
      "request insert audited",
    );
    assert.equal(d[0]?.c, "0", "approval_decisions intentionally not audited");
    console.log(
      "  ✓ audit trigger fires on matrices/chains/requests; decisions intentionally skipped",
    );
  }

  // === Test 7: effective-dating round-trip ===
  {
    const [row] = await poolSql<
      {
        effective_from: string;
        effective_to: string | null;
      }[]
    >`
      SELECT effective_from::text AS effective_from, effective_to::text AS effective_to
      FROM public.approval_matrices WHERE id = ${DBAP_MATRIX_ID}
    `;
    assert.ok(row, "matrix exists");
    assert.equal(
      new Date(row.effective_from).toISOString(),
      "2026-01-01T00:00:00.000Z",
      "effective_from round-trips",
    );
    assert.ok(row.effective_to, "effective_to is set");
    assert.equal(
      new Date(row.effective_to!).toISOString(),
      "2027-01-01T00:00:00.000Z",
      "effective_to round-trips",
    );
    console.log("  ✓ effective-dating timestamps round-trip through the matrix");
  }

  // === Test 8: polymorphism — request accepted for every subject_type ===
  {
    const subjects: { id: string; type: ApprovalSubjectType; subj: string }[] = [
      { id: DBAP_REQUEST_POLY_HC_ID, type: "headcount_envelope", subj: DBAP_SUBJECT_POLY_HC },
      { id: DBAP_REQUEST_POLY_REQ_ID, type: "requisition", subj: DBAP_SUBJECT_POLY_REQ },
      { id: DBAP_REQUEST_POLY_JD_ID, type: "jd_version", subj: DBAP_SUBJECT_POLY_JD },
      { id: DBAP_REQUEST_POLY_OF_ID, type: "offer", subj: DBAP_SUBJECT_POLY_OF },
    ];
    for (const s of subjects) {
      await poolSql`
        INSERT INTO public.approval_requests
          (id, tenant_id, chain_id, subject_type, subject_id, status)
        VALUES (${s.id}, ${testTenantId}, ${DBAP_CHAIN_ID}, ${s.type}, ${s.subj}, 'pending')
      `;
      const [row] = await poolSql<{ subject_type: string }[]>`
        SELECT subject_type FROM public.approval_requests WHERE id = ${s.id}
      `;
      assert.equal(row?.subject_type, s.type, `subject_type round-trips for ${s.type}`);
    }
    console.log(
      "  ✓ all approval_subject_type values accepted (headcount_envelope/requisition/jd_version/offer)",
    );
  }

  // === Test 9: Workday-style decision (external ref only) ===
  {
    // Use a fresh request so the decision is unique.
    await poolSql`
      INSERT INTO public.approval_requests
        (id, tenant_id, chain_id, subject_type, subject_id, status)
      VALUES (${DBAP_REQUEST_WD_ID}, ${testTenantId}, ${DBAP_CHAIN_ID}, 'requisition', ${DBAP_SUBJECT_WD}, 'pending')
    `;
    await poolSql`
      INSERT INTO public.approval_decisions
        (id, tenant_id, request_id, step_index, outcome, approver_external_ref, metadata, comment)
      VALUES (
        ${DBAP_DECISION_WD_ID},
        ${testTenantId},
        ${DBAP_REQUEST_WD_ID},
        0,
        'approved',
        'WD-APPROVAL-44219',
        ${JSON.stringify({ workday_event_id: "evt_abc123", source: "workday_webhook" })},
        'auto-approved by workday webhook'
      )
    `;
    const [row] = await poolSql<
      {
        approver_membership_id: string | null;
        approver_external_ref: string;
      }[]
    >`
      SELECT approver_membership_id, approver_external_ref
      FROM public.approval_decisions WHERE id = ${DBAP_DECISION_WD_ID}
    `;
    assert.ok(row, "workday decision row exists");
    assert.equal(row.approver_membership_id, null);
    assert.equal(row.approver_external_ref, "WD-APPROVAL-44219");
    console.log("  ✓ Workday-style external-ref-only decision accepted");
  }

  // === Test 10: session vars propagate to audit on chain advancement ===
  {
    await poolSql`
      INSERT INTO public.approval_requests
        (id, tenant_id, chain_id, subject_type, subject_id, status, requested_by_membership_id)
      VALUES (${DBAP_REQUEST_VARS_ID}, ${testTenantId}, ${DBAP_CHAIN_ID}, 'requisition', ${DBAP_SUBJECT_VARS}, 'pending', ${testMembershipId})
    `;
    const REQ_ID_PROBE = "req-dbap-vars-XYZ";
    await withTenantContext(
      decodedClaims,
      async ({ db }) => {
        await db
          .update(approvalRequests)
          .set({ status: "approved", decidedAt: new Date(), currentStepIndex: 1 })
          .where(eq(approvalRequests.id, DBAP_REQUEST_VARS_ID));
      },
      {
        actorUserId: testUserId,
        actorMembershipId: testMembershipId,
        requestId: REQ_ID_PROBE,
        userAgent: "tsx/db-approval",
        ipAddress: "198.51.100.20",
        source: "app",
      },
    );

    const [row] = await poolSql<
      {
        actor_user_id: string;
        actor_membership_id: string;
        request_id: string;
        source: string;
      }[]
    >`
      SELECT actor_user_id, actor_membership_id, request_id, source
      FROM public.audit_logs
      WHERE entity_type = 'approval_requests'
        AND entity_id = ${DBAP_REQUEST_VARS_ID}
        AND action = 'update'
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.ok(row, "update audit row exists for the chain advancement");
    assert.equal(row.actor_user_id, testUserId);
    assert.equal(row.actor_membership_id, testMembershipId);
    assert.equal(row.request_id, REQ_ID_PROBE);
    assert.equal(row.source, "app");
    console.log("  ✓ session vars propagate to audit row on chain advancement");
  }

  // Teardown — children before parents.
  await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ANY(${ALL_AUDIT_ENTITY_IDS}::uuid[])`;
  await poolSql`DELETE FROM public.approval_decisions WHERE request_id = ANY(${ALL_REQUEST_IDS}::uuid[])`;
  await poolSql`DELETE FROM public.approval_requests WHERE id = ANY(${ALL_REQUEST_IDS}::uuid[])`;
  await poolSql`DELETE FROM public.approval_chains WHERE id = ${DBAP_CHAIN_ID}`;
  await poolSql`DELETE FROM public.approval_matrices WHERE id = ${DBAP_MATRIX_ID}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${DBAP_SYNTH_TENANT_ID}`;

  console.log("\n=========================================");
  console.log("DB-APPROVAL verification: PASS");
  console.log("=========================================");
}

run()
  .then(async () => {
    // Await the pool drain so connections are returned cleanly before the
    // process exits. With `void ... ; process.exit(0)` the next sequential
    // tsx invocation (`pnpm api:test` chains this after tenant-context.test.ts)
    // can stall waiting for our orphaned connections to time out on the
    // pooler side.
    await poolSql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nDB-APPROVAL verification: FAIL");
    console.error(err);
    await poolSql.end({ timeout: 5 });
    process.exit(1);
  });
