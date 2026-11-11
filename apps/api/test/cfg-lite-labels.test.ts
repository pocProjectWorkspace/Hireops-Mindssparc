/**
 * CFG-LITE — tenant display labels (tenants.settings.labels) + recruiter
 * urgency policy (tenants.settings.urgency): admin surface, audit, and proof
 * that a stage-label override actually REACHES the user-facing surfaces.
 *
 *   Test 1: role gate — get/updateTenantLabels and get/updateUrgencySettings
 *           are admin-only (recruiter + hr_head FORBIDDEN on read and write).
 *   Test 2: admin updateTenantLabels persists OVERRIDES ONLY (blanks dropped)
 *           under the `labels` sibling key, preserves other settings keys, and
 *           writes an `update_tenant_labels` api_audit_logs row.
 *   Test 3: admin updateUrgencySettings persists + audits; a weight set that
 *           does not total 100 is rejected (BAD_REQUEST) and changes nothing.
 *   Test 4: the candidate stage-change email carries the tenant's CANDIDATE
 *           wording for the stage.
 *   Test 5: the partner stage-change email carries the tenant's PARTNER
 *           wording, and partnerGetStageLabels (the partner portal's read)
 *           returns the override + platform defaults elsewhere.
 *   Test 6: reset — saving blanks returns every surface to platform wording.
 *
 * Fully synthetic tenant (namespace c1f0) — no shared tenant's settings are
 * touched. Harness = the real appRouter via createCaller, same as
 * partner-notifications.test.ts. Requires `pnpm db:seed:test-users` (the FK
 * user test-fnd15b@hireops-dev.local).
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

const T = "00000000-0000-4000-8000-00000c1f0a01";
const BU = "00000000-0000-4000-8000-00000c1f0a02";
const MEMBERSHIP = "00000000-0000-4000-8000-00000c1f0a03";
const POSITION = "00000000-0000-4000-8000-00000c1f0a04";
const JD = "00000000-0000-4000-8000-00000c1f0a05";
const REQ = "00000000-0000-4000-8000-00000c1f0a06";
const ORG = "00000000-0000-4000-8000-00000c1f0a07";
const PARTNER_USER = "00000000-0000-4000-8000-00000c1f0a08";
const PERSON_DIRECT = "00000000-0000-4000-8000-00000c1f0a11";
const CANDIDATE_DIRECT = "00000000-0000-4000-8000-00000c1f0a12";
const APP_DIRECT = "00000000-0000-4000-8000-00000c1f0a13";
const PERSON_PARTNER = "00000000-0000-4000-8000-00000c1f0a21";
const CANDIDATE_PARTNER = "00000000-0000-4000-8000-00000c1f0a22";
const APP_PARTNER = "00000000-0000-4000-8000-00000c1f0a23";

const TENANT_SLUG = "synth-cfg-lite-labels";
const PARTNER_AUTH = randomUUID();
const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;

const CANDIDATE_SHORTLISTED = "Moved to the next step";
const PARTNER_SHORTLISTED = "Client shortlisted";
const STAFF_SHORTLISTED = "Longlist";

const log = createLogger({ level: "error" });

function makeInternalCaller(roles: string[]) {
  const ctx: HonoTRPCContext = {
    tenantId: T,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: { sub: TEST_USER_FOR_FK, tid: T, tenant_slug: TENANT_SLUG, roles },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-cfg-lite-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

function makePartnerCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-cfg-lite-p-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function expectCode(p: Promise<unknown>, code: TRPCError["code"], what: string) {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof TRPCError, `${what}: expected a TRPCError, got ${String(err)}`);
    assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code}`);
    return;
  }
  assert.fail(`${what}: expected ${code}, but the call succeeded`);
}

async function settingsRow(): Promise<Record<string, unknown>> {
  const [row] = await poolSql<{ settings: Record<string, unknown> | null }[]>`
    SELECT settings FROM public.tenants WHERE id = ${T}
  `;
  return row?.settings ?? {};
}

async function auditCount(action: string): Promise<number> {
  // withAudit writes fire-and-forget — poll briefly.
  for (let i = 0; i < 20; i++) {
    const [a] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.api_audit_logs
      WHERE tenant_id = ${T} AND action = ${action}
    `;
    if (Number(a?.n) >= 1) return Number(a?.n);
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

interface OutboxRow {
  template_key: string;
  dedup_key: string | null;
  template_data: Record<string, unknown>;
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.partner_assignments WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.partner_users WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.partner_orgs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;
}

describe("CFG-LITE tenant labels + urgency settings", () => {
  beforeAll(async () => {
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) {
      throw new Error(`prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found.`);
    }
    TEST_USER_FOR_FK = user.id;

    await cleanup();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings) VALUES (${T}, ${TENANT_SLUG}, 'CFG-LITE Synth', 'ap-northeast-1', 'active', ${JSON.stringify({ cfg_sentinel: "keep-me" })}::jsonb)`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, 'CFG BU', 'cfg-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${MEMBERSHIP}, ${T}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${POSITION}, ${T}, ${BU}, 'CFG Analyst', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${JD}, ${T}, ${POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true)`;
    await poolSql`INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active) VALUES (${ORG}, ${T}, 'CFG Partner Synth', 'empanelled', true)`;
    await poolSql`INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role, active) VALUES (${PARTNER_USER}, ${T}, ${ORG}, ${PARTNER_AUTH}, 'Priya Partner', 'priya.cfg@partner.example', 'partner_admin', true)`;

    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PERSON_DIRECT}, ${T}, 'Direct Cfg', 'direct.cfg@example.com', 'direct.cfg@example.com', '+919800000701', '919800000701')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CANDIDATE_DIRECT}, ${T}, ${PERSON_DIRECT}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_DIRECT}, ${T}, ${CANDIDATE_DIRECT}, ${REQ}, 'career_site', 'recruiter_review')`;

    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, phone_normalised) VALUES (${PERSON_PARTNER}, ${T}, 'Partner Cfg', 'partner.cfg@example.com', 'partner.cfg@example.com', '+919800000702', '919800000702')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CANDIDATE_PARTNER}, ${T}, ${PERSON_PARTNER}, 'partner_empanelled')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage, source_partner_id, submitted_by_partner_user_id) VALUES (${APP_PARTNER}, ${T}, ${CANDIDATE_PARTNER}, ${REQ}, 'partner_empanelled', 'recruiter_review', ${ORG}, ${PARTNER_USER})`;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: labels + urgency settings are admin-only (recruiter, hr_head FORBIDDEN)", async () => {
    for (const role of ["recruiter", "hr_head"]) {
      const c = makeInternalCaller([role]);
      await expectCode(c.getTenantLabels({}), "FORBIDDEN", `${role} getTenantLabels`);
      await expectCode(
        c.updateTenantLabels({ stages: { shortlisted: { staff: "X" } } }),
        "FORBIDDEN",
        `${role} updateTenantLabels`,
      );
      await expectCode(c.getUrgencySettings({}), "FORBIDDEN", `${role} getUrgencySettings`);
      await expectCode(
        c.updateUrgencySettings({
          weights: { sla: 40, daysInStage: 35, notice: 25 },
          noticeBands: [0, 30, 60, 90, 120],
        }),
        "FORBIDDEN",
        `${role} updateUrgencySettings`,
      );
    }
    const settings = await settingsRow();
    assert.equal(settings.labels, undefined, "a refused write stored nothing");
    assert.equal(settings.urgency, undefined, "a refused write stored nothing");
    assert.equal(await auditCount("update_tenant_labels"), 0, "a refused write is not audited");

    // Unconfigured tenant → no overrides; urgency = platform default.
    const admin = makeInternalCaller(["admin"]);
    const labels = await admin.getTenantLabels({});
    assert.deepEqual(labels.labels.stages, {}, "no stage overrides yet");
    assert.deepEqual(labels.labels.recommendations, {}, "no recommendation overrides yet");
    const urgency = await admin.getUrgencySettings({});
    assert.deepEqual(urgency.weights, { sla: 40, daysInStage: 35, notice: 25 });
    assert.deepEqual(urgency.noticeBands, [0, 15, 30, 60, 90]);
  });

  it("Test 2: admin labels write stores overrides only, keeps sibling keys, and is audited", async () => {
    const admin = makeInternalCaller(["admin"]);
    const out = await admin.updateTenantLabels({
      stages: {
        shortlisted: {
          staff: STAFF_SHORTLISTED,
          candidate: CANDIDATE_SHORTLISTED,
          partner: PARTNER_SHORTLISTED,
        },
        hr_round: { staff: "   " }, // blank = platform default → dropped
      },
      recommendations: { strong_yes: "Accept", no: "Reject", hold: "" },
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.labels.stages, {
      shortlisted: {
        staff: STAFF_SHORTLISTED,
        candidate: CANDIDATE_SHORTLISTED,
        partner: PARTNER_SHORTLISTED,
      },
    });
    assert.deepEqual(out.labels.recommendations, { strong_yes: "Accept", no: "Reject" });

    const settings = await settingsRow();
    assert.equal(settings.cfg_sentinel, "keep-me", "sibling settings keys are preserved");
    assert.deepEqual(
      (settings.labels as { stages: unknown }).stages,
      out.labels.stages,
      "the DB holds exactly the normalised overrides",
    );
    const read = await admin.getTenantLabels({});
    assert.deepEqual(read.labels, out.labels, "read-back equals the write echo");
    assert.ok((await auditCount("update_tenant_labels")) >= 1, "update_tenant_labels audited");
  });

  it("Test 3: admin urgency write persists + audits; weights not totalling 100 are rejected", async () => {
    const admin = makeInternalCaller(["admin"]);
    await expectCode(
      admin.updateUrgencySettings({
        weights: { sla: 40, daysInStage: 35, notice: 24 },
        noticeBands: [0, 30, 60, 90, 120],
      }),
      "BAD_REQUEST",
      "weights summing to 99",
    );
    await expectCode(
      admin.updateUrgencySettings({
        weights: { sla: 40, daysInStage: 35, notice: 25 },
        noticeBands: [0, 30, 30, 90, 120],
      }),
      "BAD_REQUEST",
      "non-ascending notice bands",
    );
    assert.equal((await settingsRow()).urgency, undefined, "a rejected write stored nothing");

    const out = await admin.updateUrgencySettings({
      weights: { sla: 30, daysInStage: 30, notice: 40 },
      noticeBands: [0, 30, 60, 90, 120],
    });
    assert.deepEqual(out.urgency.weights, { sla: 30, daysInStage: 30, notice: 40 });
    assert.deepEqual(out.urgency.noticeBands, [0, 30, 60, 90, 120]);
    const read = await admin.getUrgencySettings({});
    assert.deepEqual(read, out.urgency, "read-back equals the write echo");
    assert.equal((await settingsRow()).cfg_sentinel, "keep-me", "sibling keys preserved");
    assert.ok(
      (await auditCount("update_urgency_settings")) >= 1,
      "update_urgency_settings audited",
    );
  });

  it("Test 4: the candidate stage email uses the tenant's candidate wording", async () => {
    const internal = makeInternalCaller(["recruiter"]);
    await internal.advanceApplication({ applicationId: APP_DIRECT, targetStage: "shortlisted" });
    const rows = await poolSql<OutboxRow[]>`
      SELECT template_key, dedup_key, template_data FROM public.notification_outbox
      WHERE tenant_id = ${T} AND template_key = 'candidate.stage_advanced'
        AND recipient_email = 'direct.cfg@example.com'
    `;
    assert.equal(rows.length, 1, "one candidate stage email");
    assert.equal(
      rows[0]?.template_data.newStageLabel,
      CANDIDATE_SHORTLISTED,
      "the tenant's CANDIDATE wording, not the staff or partner one",
    );
  });

  it("Test 5: the partner stage email + partner portal read use the tenant's partner wording", async () => {
    const internal = makeInternalCaller(["recruiter"]);
    await internal.advanceApplication({ applicationId: APP_PARTNER, targetStage: "shortlisted" });
    const rows = await poolSql<OutboxRow[]>`
      SELECT template_key, dedup_key, template_data FROM public.notification_outbox
      WHERE tenant_id = ${T} AND dedup_key = ${`partner_stage:${APP_PARTNER}:shortlisted`}
    `;
    assert.equal(rows.length, 1, "one partner stage email");
    assert.equal(rows[0]?.template_data.stageLabel, PARTNER_SHORTLISTED, "partner wording");

    const portal = await makePartnerCaller(PARTNER_AUTH).partnerGetStageLabels();
    assert.equal(portal.labels.shortlisted, PARTNER_SHORTLISTED, "override reaches the portal");
    assert.equal(portal.labels.application_received, "Submitted", "platform default elsewhere");
    assert.equal(portal.labels.recruiter_rejected, "Not moving forward");
  });

  it("Test 6: saving blanks resets every surface to platform wording", async () => {
    const admin = makeInternalCaller(["admin"]);
    const out = await admin.updateTenantLabels({
      stages: { shortlisted: { staff: "", candidate: "", partner: "" } },
      recommendations: {},
    });
    assert.deepEqual(out.labels.stages, {}, "no overrides left");
    const portal = await makePartnerCaller(PARTNER_AUTH).partnerGetStageLabels();
    assert.equal(portal.labels.shortlisted, "Shortlisted", "back to the platform partner label");
  });
});
