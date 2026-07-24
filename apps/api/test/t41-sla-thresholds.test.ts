/**
 * T4.1 — tenant-configurable SLA thresholds (tenants.settings.slaThresholds).
 *
 * Honesty focus: a tenant's per-stage SLA hours are genuinely PERSISTED and
 * CONSUMED — the saved thresholds actually DRIVE breach behavior, not merely the
 * UI. Exercised over real cloud-minted JWTs (reality #110 — sign in as the
 * seeded personas):
 *
 *   Test 1: updateSlaThresholds (admin) persists a partial override map →
 *           getSlaThresholds (admin) returns the full resolved map + the raw
 *           override is in the DB jsonb.
 *   Test 2: resolve-over-defaults — an UNCONFIGURED tenant resolves to the
 *           hardcoded SLA_THRESHOLDS_HOURS (byte-identical to today).
 *   Test 3: a malformed / out-of-range stored value falls back to that stage's
 *           default; a terminal-stage override is ignored (stays null).
 *   Test 4: role gating — admin + hr_head can read AND write; recruiter is
 *           FORBIDDEN on both read and write; hiring_manager FORBIDDEN on write.
 *   Test 5: HONESTY — with an override that LOWERS recruiter_review's hours, a
 *           synthetic application that was NOT breaching at the default (30h in
 *           stage vs 48h SLA) FLIPS to breaching (vs a 24h SLA) in the real
 *           listCandidates slaBreachOnly filter — the override drives the filter,
 *           not just display.
 *   Test 6: tenant isolation — the atomic settings merge only touches the acting
 *           tenant; a synthetic sibling tenant's settings are untouched.
 *   Test 7: resolveSlaThresholds unit — override applied, malformed ignored,
 *           explicit null disables, terminal stays null, garbage → full defaults.
 *
 * kyndryl-poc's settings jsonb is snapshotted in beforeAll and restored verbatim
 * in afterAll, so the demo config is never clobbered. Requires
 * `pnpm db:seed:test-users` (admin1 / hrhead1 / recruiter1 / hiringmanager1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { SLA_THRESHOLDS_HOURS, resolveSlaThresholds } from "../src/lib/sla-thresholds";

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
const SYNTH_SLUG = "t41-synth-sla";

// Synthetic FK chain in kyndryl-poc so RLS lets the recruiter read the row the
// honesty filter operates on. Proper v4 UUID structure.
const T41_BU = "00000000-0000-4000-8000-000000410b01";
const T41_POSITION = "00000000-0000-4000-8000-000000410b02";
const T41_JD = "00000000-0000-4000-8000-000000410b03";
const T41_REQ = "00000000-0000-4000-8000-000000410b04";
const T41_PERSON = "00000000-0000-4000-8000-000000410b05";
const T41_CANDIDATE = "00000000-0000-4000-8000-000000410b06";
const T41_APP = "00000000-0000-4000-8000-000000410b07";

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
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
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

type ResolvedMap = Record<string, number | null>;

let adminJwt: string;
let hrHeadJwt: string;
let recruiterJwt: string;
let hmJwt: string;
let tenantId: string;
let recruiterMembershipId: string;
let originalSettings: unknown = {};

async function stripSlaThresholds() {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'slaThresholds' WHERE id = ${tenantId}
  `;
}

describe("T4.1 — tenant-configurable SLA thresholds", () => {
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
    originalSettings = t.settings ?? {};
    await stripSlaThresholds();

    // Recruiter's membership — the synthetic req's primary recruiter so
    // listCandidates scopes the honesty row to them.
    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE au.email = ${RECRUITER} AND tum.tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (!m) throw new Error(`recruiter membership for ${RECRUITER} not found`);
    recruiterMembershipId = m.id;

    // Synthetic sibling tenant for the isolation test.
    await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT}`;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${SYNTH_TENANT}, ${SYNTH_SLUG}, 'T4.1 Synth', 'ap-northeast-1', 'active',
              ${JSON.stringify({ t41_sentinel: "keep-me" })}::jsonb)
    `;

    // Synthetic FK chain in kyndryl-poc for the honesty test.
    await cleanupChain();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${T41_BU}, ${tenantId}, 'T41 BU', 't41-bu')`;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${T41_POSITION}, ${tenantId}, ${T41_BU}, 'T41 Eng', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${T41_JD}, ${tenantId}, ${T41_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${T41_REQ}, ${tenantId}, ${T41_POSITION}, ${T41_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${T41_PERSON}, ${tenantId}, 'T41 Tester', 't41-test@example.com', 't41-test@example.com')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${T41_CANDIDATE}, ${tenantId}, ${T41_PERSON}, 'career_site', 'v1')
    `;
  });

  afterAll(async () => {
    try {
      await cleanupChain();
    } catch {
      // best-effort
    }
    try {
      await poolSql`
        UPDATE public.tenants
        SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort restore
    }
    try {
      await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT}`;
    } catch {
      // best-effort cleanup
    }
  });

  async function cleanupChain() {
    await poolSql`DELETE FROM public.applications WHERE id = ${T41_APP}`;
    await poolSql`DELETE FROM public.candidates WHERE id = ${T41_CANDIDATE}`;
    await poolSql`DELETE FROM public.persons WHERE id = ${T41_PERSON}`;
    await poolSql`DELETE FROM public.requisitions WHERE id = ${T41_REQ}`;
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${T41_JD}`;
    await poolSql`DELETE FROM public.positions WHERE id = ${T41_POSITION}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${T41_BU}`;
  }

  it("Test 1: admin update persists a partial override; get returns the merged map + DB carries the raw override", async () => {
    const override = { recruiter_review: 12, tech_interview: 100 };
    const up = await trpcMutation<{ ok: true; slaThresholds: ResolvedMap }>(
      "updateSlaThresholds",
      override,
      adminJwt,
    );
    assert.ok(!isErr(up), `updateSlaThresholds (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.ok, true);
    assert.equal(up.result.data.slaThresholds.recruiter_review, 12, "override wins in the echo");
    assert.equal(up.result.data.slaThresholds.tech_interview, 100);
    assert.equal(
      up.result.data.slaThresholds.hr_round,
      SLA_THRESHOLDS_HOURS.hr_round,
      "omitted stage falls back to the code default",
    );
    assert.equal(up.result.data.slaThresholds.offer_accepted, null, "terminal stays null");

    const get = await trpcQuery<ResolvedMap>("getSlaThresholds", {}, adminJwt);
    assert.ok(!isErr(get), `getSlaThresholds (admin): ${JSON.stringify(get)}`);
    assert.deepEqual(
      get.result.data,
      resolveSlaThresholds(override),
      "get reflects the resolved merged map",
    );

    // Genuinely persisted as the raw override in the DB jsonb, not just echoed.
    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.deepEqual(
      row!.settings["slaThresholds"],
      override,
      "raw override persisted to tenants.settings jsonb",
    );
  });

  it("Test 2: an unconfigured tenant resolves to the hardcoded SLA_THRESHOLDS_HOURS", async () => {
    await stripSlaThresholds();
    const get = await trpcQuery<ResolvedMap>("getSlaThresholds", {}, adminJwt);
    assert.ok(!isErr(get), `getSlaThresholds: ${JSON.stringify(get)}`);
    assert.deepEqual(
      get.result.data,
      SLA_THRESHOLDS_HOURS,
      "resolve merges over defaults byte-identical to the code constant",
    );
  });

  it("Test 3: malformed / out-of-range stored values fall back to defaults; terminal override ignored", async () => {
    // Write a corrupt block directly, bypassing the write schema.
    await poolSql`
      UPDATE public.tenants
      SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('slaThresholds', ${JSON.stringify({
            recruiter_review: 0, // out of range (>0 required)
            tech_interview: 999999, // out of range (<= 8760)
            ai_screening: "nope", // wrong type
            hr_round: 30, // valid — should win
            offer_accepted: 5, // terminal — must be ignored
          })}::jsonb)
      WHERE id = ${tenantId}
    `;
    const get = await trpcQuery<ResolvedMap>("getSlaThresholds", {}, adminJwt);
    assert.ok(!isErr(get), `getSlaThresholds: ${JSON.stringify(get)}`);
    assert.equal(
      get.result.data.recruiter_review,
      SLA_THRESHOLDS_HOURS.recruiter_review,
      "0 is out of range → default",
    );
    assert.equal(
      get.result.data.tech_interview,
      SLA_THRESHOLDS_HOURS.tech_interview,
      "999999 is out of range → default",
    );
    assert.equal(
      get.result.data.ai_screening,
      SLA_THRESHOLDS_HOURS.ai_screening,
      "wrong type → default",
    );
    assert.equal(get.result.data.hr_round, 30, "valid stored override wins");
    assert.equal(get.result.data.offer_accepted, null, "terminal override ignored → null");
    await stripSlaThresholds();
  });

  it("Test 4: admin + hr_head can read AND write; recruiter FORBIDDEN (read+write); hiring_manager FORBIDDEN (write)", async () => {
    // Admin write + read already exercised — assert hr_head parity.
    const hrWrite = await trpcMutation<{ ok: true }>(
      "updateSlaThresholds",
      { recruiter_review: 40 },
      hrHeadJwt,
    );
    assert.ok(!isErr(hrWrite), `hr_head update allowed: ${JSON.stringify(hrWrite)}`);
    const hrRead = await trpcQuery<ResolvedMap>("getSlaThresholds", {}, hrHeadJwt);
    assert.ok(!isErr(hrRead), `hr_head read allowed: ${JSON.stringify(hrRead)}`);
    assert.equal(hrRead.result.data.recruiter_review, 40);

    // Recruiter denied on BOTH read and write.
    const recRead = await trpcQuery<ResolvedMap>("getSlaThresholds", {}, recruiterJwt);
    assert.ok(
      isErr(recRead) && recRead.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on read: ${JSON.stringify(recRead)}`,
    );
    const recWrite = await trpcMutation(
      "updateSlaThresholds",
      { recruiter_review: 10 },
      recruiterJwt,
    );
    assert.ok(
      isErr(recWrite) && recWrite.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on write: ${JSON.stringify(recWrite)}`,
    );

    // Hiring manager denied on write.
    const hmWrite = await trpcMutation("updateSlaThresholds", { recruiter_review: 10 }, hmJwt);
    assert.ok(
      isErr(hmWrite) && hmWrite.error.data.code === "FORBIDDEN",
      `hiring_manager FORBIDDEN on write: ${JSON.stringify(hmWrite)}`,
    );
    await stripSlaThresholds();
  });

  it("Test 5: HONESTY — lowering recruiter_review's SLA flips a 30h-old app from non-breaching to breaching in listCandidates", async () => {
    // Seed one application 30h into recruiter_review. Default SLA is 48h → NOT
    // breaching; a 24h override → breaching.
    await stripSlaThresholds();
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${T41_APP}, ${tenantId}, ${T41_CANDIDATE}, ${T41_REQ}, 'career_site',
              'recruiter_review', now() - interval '30 hours')
    `;

    const listInput = {
      filters: { slaBreachOnly: true, requisitionId: T41_REQ },
      pagination: { limit: 50 },
      sort: "sla_breach",
    };

    // (a) at the code default (48h), 30h in stage is NOT a breach.
    const before = await trpcQuery<{ rows: { applicationId: string }[] }>(
      "listCandidates",
      listInput,
      recruiterJwt,
    );
    assert.ok(!isErr(before), `listCandidates (default): ${JSON.stringify(before)}`);
    assert.ok(
      !before.result.data.rows.some((r) => r.applicationId === T41_APP),
      "at the 48h default, the 30h-old app must NOT be a breach",
    );

    // (b) lower recruiter_review to 24h → the SAME app now breaches.
    const up = await trpcMutation("updateSlaThresholds", { recruiter_review: 24 }, adminJwt);
    assert.ok(!isErr(up), `updateSlaThresholds: ${JSON.stringify(up)}`);
    const after = await trpcQuery<{ rows: { applicationId: string }[] }>(
      "listCandidates",
      listInput,
      recruiterJwt,
    );
    assert.ok(!isErr(after), `listCandidates (override): ${JSON.stringify(after)}`);
    assert.ok(
      after.result.data.rows.some((r) => r.applicationId === T41_APP),
      "after lowering the SLA to 24h, the 30h-old app FLIPS to a breach — the override drives the real filter",
    );
    await stripSlaThresholds();
  });

  it("Test 6: tenant isolation — the settings merge only touches the acting tenant", async () => {
    const up = await trpcMutation("updateSlaThresholds", { recruiter_review: 33 }, adminJwt);
    assert.ok(!isErr(up), `updateSlaThresholds: ${JSON.stringify(up)}`);

    const [synth] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${SYNTH_TENANT}
    `;
    assert.equal(synth!.settings["t41_sentinel"], "keep-me", "sibling tenant sentinel preserved");
    assert.equal(
      synth!.settings["slaThresholds"],
      undefined,
      "sibling tenant did NOT receive the update",
    );
    await stripSlaThresholds();
  });

  it("Test 7: resolveSlaThresholds unit — override, malformed, explicit null, terminal, garbage", () => {
    // Override applied.
    assert.equal(resolveSlaThresholds({ recruiter_review: 10 }).recruiter_review, 10);
    // Malformed values ignored (fall back to defaults).
    assert.equal(
      resolveSlaThresholds({ recruiter_review: 0 }).recruiter_review,
      SLA_THRESHOLDS_HOURS.recruiter_review,
    );
    assert.equal(
      resolveSlaThresholds({ tech_interview: 99999 }).tech_interview,
      SLA_THRESHOLDS_HOURS.tech_interview,
    );
    assert.equal(
      resolveSlaThresholds({ ai_screening: "x" }).ai_screening,
      SLA_THRESHOLDS_HOURS.ai_screening,
    );
    // Explicit null disables the stage's SLA.
    assert.equal(resolveSlaThresholds({ recruiter_review: null }).recruiter_review, null);
    // Terminal override ignored — stays null.
    assert.equal(resolveSlaThresholds({ offer_accepted: 5 }).offer_accepted, null);
    // Garbage (non-object / array / null) → full default map.
    assert.deepEqual(resolveSlaThresholds("garbage"), SLA_THRESHOLDS_HOURS);
    assert.deepEqual(resolveSlaThresholds(null), SLA_THRESHOLDS_HOURS);
    assert.deepEqual(resolveSlaThresholds([1, 2, 3]), SLA_THRESHOLDS_HOURS);
    // Unknown keys ignored, valid keys applied.
    const mixed = resolveSlaThresholds({ bogus: 5, hr_round: 60 });
    assert.equal(mixed.hr_round, 60);
    assert.equal(mixed.recruiter_review, SLA_THRESHOLDS_HOURS.recruiter_review);
  });
});
