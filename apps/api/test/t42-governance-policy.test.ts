/**
 * T4.2 — configurable governance / compliance policy
 * (tenants.settings.governancePolicy).
 *
 * Honesty focus: a tenant's governance policy is genuinely PERSISTED and
 * CONSUMED — the saved weights actually MOVE the executive-audit compliance
 * score, and the saved approval-SLA days actually flip a pending approval into a
 * risk flag. Not a display. Exercised over real cloud-minted JWTs (reality #110 —
 * sign in as the seeded personas):
 *
 *   Test 1: updateGovernancePolicy (admin) persists a non-default policy →
 *           getGovernancePolicy (admin) returns it + the raw block is in the DB
 *           jsonb; a synthetic sibling tenant is untouched (isolation).
 *   Test 2: resolve-over-defaults — an UNCONFIGURED tenant resolves to the code
 *           constants (defaultGovernancePolicy — byte-identical to today).
 *   Test 3: weights not summing to 100 → BAD_REQUEST on update.
 *   Test 4: role gating — admin + hr_head can read AND write; recruiter is
 *           FORBIDDEN on both; hiring_manager FORBIDDEN on write.
 *   Test 5: HONESTY (score) — with a re-weighted policy (100% on the lowest-value
 *           compliance component) the executive-audit complianceScore MOVES for
 *           the SAME underlying data, matching round(100 * that component's value).
 *   Test 6: HONESTY (flags) — lowering approvalSlaDays flags a controlled pending
 *           approval (rule b) that was NOT breaching at the default SLA.
 *
 * kyndryl-poc's settings jsonb is snapshotted in beforeAll and restored verbatim
 * in afterAll, so the demo config is never clobbered. Seeds a self-contained
 * approval matrix + chain + requests inside kyndryl-poc (cleaned up in afterAll).
 * Requires `pnpm db:seed:test-users` (admin1 / hrhead1 / recruiter1 /
 * hiringmanager1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  COMPLIANCE_WEIGHTS,
  REQUISITION_APPROVAL_SLA_DAYS,
  FEEDBACK_SLA_HOURS,
  UNREALISTIC_MUST_HAVE_THRESHOLD,
  defaultGovernancePolicy,
  type GovernancePolicy,
  type GetExecutiveAuditOutput,
  type GetGovernanceRiskFlagsOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HIRING_MANAGER = "hiringmanager1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const SYNTH_TENANT = randomUUID();
const SYNTH_SLUG = "t42-synth-gov";

// t42 synth namespace (groom-safe — deleted in afterAll).
const N = "00000000-0000-4000-8000-0000c0f42b";
const MATRIX = `${N}01`;
const CHAIN = `${N}02`;
const PENDING_REQ = `${N}03`;
const PENDING_SUBJECT = `${N}04`;

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const q = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${q}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

let adminJwt: string;
let hrHeadJwt: string;
let recruiterJwt: string;
let hmJwt: string;
let tenantId: string;
let membershipId: string;
let originalSettings: unknown = {};

async function stripPolicy() {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'governancePolicy' WHERE id = ${tenantId}
  `;
}

/** A complete policy that overrides `partial` over the code defaults. */
function policyWith(partial: Partial<GovernancePolicy>): GovernancePolicy {
  const base = defaultGovernancePolicy();
  return {
    weights: partial.weights ?? base.weights,
    approvalSlaDays: partial.approvalSlaDays ?? base.approvalSlaDays,
    feedbackSlaHours: partial.feedbackSlaHours ?? base.feedbackSlaHours,
    unrealisticMustHaveThreshold:
      partial.unrealisticMustHaveThreshold ?? base.unrealisticMustHaveThreshold,
  };
}

async function cleanupApprovals() {
  await poolSql`DELETE FROM public.approval_requests WHERE tenant_id = ${tenantId} AND chain_id = ${CHAIN}`;
  await poolSql`DELETE FROM public.approval_chains WHERE tenant_id = ${tenantId} AND id = ${CHAIN}`;
  await poolSql`DELETE FROM public.approval_matrices WHERE tenant_id = ${tenantId} AND id = ${MATRIX}`;
}

describe("T4.2 — configurable governance/compliance policy", () => {
  beforeAll(async () => {
    [adminJwt, hrHeadJwt, recruiterJwt, hmJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(HR_HEAD),
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    // Snapshot the PRISTINE settings — strip any governancePolicy so a killed
    // prior run's residue is never "restored" in afterAll (T4.2 adds this key,
    // the demo tenant never had it).
    originalSettings = (() => {
      const s = { ...((t.settings ?? {}) as Record<string, unknown>) };
      delete s["governancePolicy"];
      return s;
    })();
    await stripPolicy();

    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE tenant_id = ${tenantId} AND status = 'active'
      LIMIT 1
    `;
    if (!m) throw new Error("no active membership in kyndryl-poc");
    membershipId = m.id;

    // Synthetic sibling tenant for the isolation test. Delete by SLUG (not just
    // the fresh random id) so a killed prior run's orphaned row can't collide on
    // the unique slug.
    await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT} OR slug = ${SYNTH_SLUG}`;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${SYNTH_TENANT}, ${SYNTH_SLUG}, 'T4.2 Synth', 'ap-northeast-1', 'active',
              ${JSON.stringify({ t42_sentinel: "keep-me" })}::jsonb)
    `;

    // Self-contained matrix + chain so the honesty tests can seed approval_requests.
    await cleanupApprovals();
    await poolSql`
      INSERT INTO public.approval_matrices
        (id, tenant_id, subject_type, name, rules, effective_from, effective_to, created_by_membership_id)
      VALUES (${MATRIX}, ${tenantId}, 'requisition', 'T4.2 Test Matrix',
              ${JSON.stringify({ steps: [{ approver_kind: "role", approver_ref: "hiring_manager", required: true }] })},
              '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', ${membershipId})
    `;
    await poolSql`
      INSERT INTO public.approval_chains
        (id, tenant_id, matrix_id, matrix_version_snapshot, resolved_steps)
      VALUES (${CHAIN}, ${tenantId}, ${MATRIX},
              ${JSON.stringify({ steps: [{ approver_kind: "role", approver_ref: "hiring_manager" }] })},
              ${JSON.stringify([{ step_index: 0, approver_kind: "membership", approver_ref: membershipId, required: true, order_index: 0 }])})
    `;
    // 120 decided-LATE requisition approvals (decided 10 days after request, well
    // past any realistic SLA) → the approvals_within_sla compliance component is
    // driven clearly below 1 for the honesty (score) test.
    await poolSql`
      INSERT INTO public.approval_requests
        (tenant_id, chain_id, subject_type, subject_id, status, requested_at, decided_at)
      SELECT ${tenantId}, ${CHAIN}, 'requisition', gen_random_uuid(), 'approved',
             now() - interval '30 days', now() - interval '20 days'
      FROM generate_series(1, 120)
    `;
    // One controlled PENDING approval, requested 36h ago. At the default 2-day
    // SLA it is NOT overdue; lowering approvalSlaDays to 1 flips it to a flag.
    await poolSql`
      INSERT INTO public.approval_requests
        (id, tenant_id, chain_id, subject_type, subject_id, status, requested_at)
      VALUES (${PENDING_REQ}, ${tenantId}, ${CHAIN}, 'requisition', ${PENDING_SUBJECT},
              'pending', now() - interval '36 hours')
    `;
  });

  afterAll(async () => {
    try {
      await cleanupApprovals();
    } catch {
      /* best-effort — groom sweep picks up residue */
    }
    try {
      await poolSql`
        UPDATE public.tenants SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      /* best-effort restore */
    }
    try {
      await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT} OR slug = ${SYNTH_SLUG}`;
    } catch {
      /* best-effort cleanup */
    }
  });

  it("Test 1: admin update persists a non-default policy; get returns it; DB carries the raw block; sibling tenant untouched", async () => {
    const policy = policyWith({
      weights: {
        approvals_within_sla: 40,
        feedback_within_48h: 20,
        onboarding_docs_verified: 20,
        offers_within_band: 20,
      },
      approvalSlaDays: 5,
      feedbackSlaHours: 72,
      unrealisticMustHaveThreshold: 8,
    });
    const up = await trpcMutation<{ ok: true; governancePolicy: GovernancePolicy }>(
      "updateGovernancePolicy",
      policy,
      adminJwt,
    );
    assert.ok(!isErr(up), `updateGovernancePolicy (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.ok, true);
    assert.deepEqual(up.result.data.governancePolicy, policy, "echo matches the saved policy");

    const get = await trpcQuery<GovernancePolicy>("getGovernancePolicy", {}, adminJwt);
    assert.ok(!isErr(get), `getGovernancePolicy (admin): ${JSON.stringify(get)}`);
    assert.deepEqual(get.result.data, policy, "get reflects the saved policy");

    // Genuinely persisted as the raw block in the DB jsonb.
    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.deepEqual(
      row!.settings["governancePolicy"],
      policy,
      "raw policy persisted to tenants.settings jsonb",
    );

    // Sibling tenant did NOT receive the update.
    const [synth] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${SYNTH_TENANT}
    `;
    assert.equal(synth!.settings["t42_sentinel"], "keep-me", "sibling sentinel preserved");
    assert.equal(synth!.settings["governancePolicy"], undefined, "sibling did NOT receive update");

    await stripPolicy();
  });

  it("Test 2: an unconfigured tenant resolves to the code constants", async () => {
    await stripPolicy();
    const get = await trpcQuery<GovernancePolicy>("getGovernancePolicy", {}, adminJwt);
    assert.ok(!isErr(get), `getGovernancePolicy: ${JSON.stringify(get)}`);
    assert.deepEqual(
      get.result.data,
      defaultGovernancePolicy(),
      "resolves to defaultGovernancePolicy()",
    );
    // And the default is built FROM the code constants.
    assert.deepEqual(get.result.data.weights, {
      approvals_within_sla: COMPLIANCE_WEIGHTS.approvals_within_sla,
      feedback_within_48h: COMPLIANCE_WEIGHTS.feedback_within_48h,
      onboarding_docs_verified: COMPLIANCE_WEIGHTS.onboarding_docs_verified,
      offers_within_band: COMPLIANCE_WEIGHTS.offers_within_band,
    });
    assert.equal(get.result.data.approvalSlaDays, REQUISITION_APPROVAL_SLA_DAYS);
    assert.equal(get.result.data.feedbackSlaHours, FEEDBACK_SLA_HOURS);
    assert.equal(get.result.data.unrealisticMustHaveThreshold, UNREALISTIC_MUST_HAVE_THRESHOLD);
  });

  it("Test 3: weights not summing to 100 → BAD_REQUEST", async () => {
    const bad = policyWith({
      weights: {
        approvals_within_sla: 30,
        feedback_within_48h: 25,
        onboarding_docs_verified: 25,
        offers_within_band: 10, // sums to 90
      },
    });
    const up = await trpcMutation("updateGovernancePolicy", bad, adminJwt);
    assert.ok(
      isErr(up) && up.error.data.code === "BAD_REQUEST",
      `weights summing to 90 must be BAD_REQUEST: ${JSON.stringify(up)}`,
    );
    // And it did NOT persist.
    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.equal(row!.settings["governancePolicy"], undefined, "invalid policy did not persist");
  });

  it("Test 4: admin + hr_head read AND write; recruiter FORBIDDEN (read+write); hiring_manager FORBIDDEN (write)", async () => {
    const p = policyWith({ approvalSlaDays: 4 });

    // hr_head parity — write + read.
    const hrWrite = await trpcMutation<{ ok: true }>("updateGovernancePolicy", p, hrHeadJwt);
    assert.ok(!isErr(hrWrite), `hr_head update allowed: ${JSON.stringify(hrWrite)}`);
    const hrRead = await trpcQuery<GovernancePolicy>("getGovernancePolicy", {}, hrHeadJwt);
    assert.ok(!isErr(hrRead), `hr_head read allowed: ${JSON.stringify(hrRead)}`);
    assert.equal(hrRead.result.data.approvalSlaDays, 4);

    // Recruiter denied on BOTH read and write.
    const recRead = await trpcQuery<GovernancePolicy>("getGovernancePolicy", {}, recruiterJwt);
    assert.ok(
      isErr(recRead) && recRead.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on read: ${JSON.stringify(recRead)}`,
    );
    const recWrite = await trpcMutation("updateGovernancePolicy", p, recruiterJwt);
    assert.ok(
      isErr(recWrite) && recWrite.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on write: ${JSON.stringify(recWrite)}`,
    );

    // Hiring manager denied on write.
    const hmWrite = await trpcMutation("updateGovernancePolicy", p, hmJwt);
    assert.ok(
      isErr(hmWrite) && hmWrite.error.data.code === "FORBIDDEN",
      `hiring_manager FORBIDDEN on write: ${JSON.stringify(hmWrite)}`,
    );

    await stripPolicy();
  });

  it("Test 5: HONESTY (score) — re-weighting genuinely moves the executive-audit complianceScore", async () => {
    await stripPolicy();

    // (a) default weights.
    const d1 = await trpcQuery<GetExecutiveAuditOutput>("getExecutiveAudit", undefined, hrHeadJwt);
    assert.ok(!isErr(d1), `getExecutiveAudit (default): ${JSON.stringify(d1)}`);
    const comps = d1.result.data.components;
    const defaultScore = d1.result.data.kpis.complianceScore;

    // The returned score is exactly the weighted composite of the components.
    const recomputed = Math.round(comps.reduce((acc, c) => acc + c.value * c.weightPct, 0));
    assert.equal(defaultScore, recomputed, "default score is Σ value*weightPct");

    // The seeded late approvals drive approvals_within_sla clearly below 1, so
    // there is real spread across the four component values.
    const byKey = new Map(comps.map((c) => [c.key, c] as const));
    const values = comps.map((c) => c.value);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    assert.ok(
      minVal <= 0.9,
      `seeded data drives at least one component well below 1 (min=${minVal})`,
    );
    assert.ok(maxVal - minVal >= 0.05, `components have real spread (max-min=${maxVal - minVal})`);
    const minComp = comps.find((c) => c.value === minVal)!;

    // (b) re-weight: 100% on the lowest-value component, 0 on the rest. Keep the
    // SLA knobs at default so the component VALUES are unchanged — only the
    // weights move — isolating the weight effect on the score.
    const weights = {
      approvals_within_sla: 0,
      feedback_within_48h: 0,
      onboarding_docs_verified: 0,
      offers_within_band: 0,
    } as GovernancePolicy["weights"];
    weights[minComp.key] = 100;
    const up = await trpcMutation("updateGovernancePolicy", policyWith({ weights }), adminJwt);
    assert.ok(!isErr(up), `updateGovernancePolicy: ${JSON.stringify(up)}`);

    const d2 = await trpcQuery<GetExecutiveAuditOutput>("getExecutiveAudit", undefined, hrHeadJwt);
    assert.ok(!isErr(d2), `getExecutiveAudit (reweighted): ${JSON.stringify(d2)}`);
    const reweightedScore = d2.result.data.kpis.complianceScore;

    // Component values unchanged (only weights moved).
    const min2 = d2.result.data.components.find((c) => c.key === minComp.key)!;
    assert.equal(
      min2.value,
      byKey.get(minComp.key)!.value,
      "component values stable across reweight",
    );
    assert.equal(min2.weightPct, 100, "the reweighted component now carries all the weight");

    // The score now equals round(100 * that component's value) — the tenant
    // weights genuinely drive it — and it MOVED versus the default weighting.
    assert.equal(
      reweightedScore,
      Math.round(min2.value * 100),
      "reweighted score = round(100 * min component value)",
    );
    assert.notEqual(
      reweightedScore,
      defaultScore,
      "the score genuinely moved when weights changed",
    );

    await stripPolicy();
  });

  it("Test 6: HONESTY (flags) — lowering approvalSlaDays flips a 36h pending approval into a risk flag", async () => {
    await stripPolicy();

    const findFlag = (data: GetGovernanceRiskFlagsOutput) =>
      data.flags.find(
        (f) => f.rule === "requisition_approval_overdue" && f.entityId === PENDING_SUBJECT,
      );

    // (a) at the default 2-day SLA, the 36h-old pending approval is NOT overdue.
    const before = await trpcQuery<GetGovernanceRiskFlagsOutput>(
      "getGovernanceRiskFlags",
      undefined,
      adminJwt,
    );
    assert.ok(!isErr(before), `getGovernanceRiskFlags (default): ${JSON.stringify(before)}`);
    assert.ok(
      !findFlag(before.result.data),
      "at the 2-day default, the 36h pending approval must NOT be flagged",
    );

    // (b) lower approvalSlaDays to 1 day → the SAME approval now flags overdue.
    const up = await trpcMutation(
      "updateGovernancePolicy",
      policyWith({ approvalSlaDays: 1 }),
      adminJwt,
    );
    assert.ok(!isErr(up), `updateGovernancePolicy: ${JSON.stringify(up)}`);

    const after = await trpcQuery<GetGovernanceRiskFlagsOutput>(
      "getGovernanceRiskFlags",
      undefined,
      adminJwt,
    );
    assert.ok(!isErr(after), `getGovernanceRiskFlags (override): ${JSON.stringify(after)}`);
    const flag = findFlag(after.result.data);
    assert.ok(flag, "after lowering approvalSlaDays to 1, the pending approval FLIPS to a flag");
    assert.equal(flag!.severity, "high");
    assert.match(flag!.detail, /SLA is 1 days/, "the flag detail reflects the tenant policy");

    await stripPolicy();
  });
});
