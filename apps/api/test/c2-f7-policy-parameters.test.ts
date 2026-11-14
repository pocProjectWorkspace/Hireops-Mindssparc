/**
 * C2-F7 — policy parameters (Plan A §8): admin surface, audit, and one
 * behavioural check per block that the saved value actually reaches its
 * consumer.
 *
 *   Test 1  role gate — get/updatePolicyParameters are admin-only (recruiter,
 *           hr_head FORBIDDEN on read and write); a refused write stores
 *           nothing and is not audited.
 *   Test 2  admin write persists the block as a sibling key (other settings
 *           survive), is audited (`update_policy_parameters`), and an
 *           out-of-range value is BAD_REQUEST and changes nothing.
 *   Test 3  screeningPolicy.acceptingStatuses — an `approved` req stops
 *           resolving publicly when the tenant accepts only `posted`.
 *   Test 4  screeningPolicy.reapplyCoolingOffDays — a person rejected 5 days
 *           ago cannot re-apply under a 30-day cooling-off; 0 lets them.
 *   Test 5  uploadPolicy.resumeTypes — a PDF-only tenant refuses a stored DOCX.
 *   Test 6  offerPolicy — draftOffer without expiryDays uses the tenant default;
 *           the executive-audit offer-decision row carries the configured SLA
 *           in its target AND label.
 *   Test 7  reportPolicy — time to fill measured from requisition approval
 *           instead of application creation.
 *   Test 8  retentionPolicy.talentPoolRetentionMonths — the CV register lists
 *           a stale never-hired candidate, and stops when the window widens.
 *   Test 9  marketIntelPolicy + getOfferPolicyDefaults readable by a recruiter.
 *   Pure    risk flags (compa-ratio), req-health weights, JD cap, AI question
 *           range, notetaker glossary, dedup match modes.
 *
 * Fully synthetic tenant (namespace c2f7) — no shared tenant is touched.
 * Requires `pnpm db:seed:test-users` (FK user test-fnd15b@hireops-dev.local).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRPCError } from "@trpc/server";
import { db as poolDb, sql as poolSql, type TenantBoundDb } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { buildAIScoringPrompt } from "@hireops/ai-scoring";
import type { ParserOutput } from "@hireops/ai-client";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { getStorageClient, resetStorageClient } from "../src/lib/storage";
import { computeRiskFlags } from "../src/lib/recruiter-urgency";
import { computeReqHealth, REQ_HEALTH_WEIGHTS } from "../src/lib/req-health";
import { targetQuestionCount } from "../src/lib/ai-interview-questions";
import { decideDedupMatch } from "../src/lib/application-ingest";
import { computeExecutiveAudit } from "../src/lib/governance";
import { timeToFillStats } from "../src/lib/reports/measures";
import { buildInterviewKeyterms } from "../../../apps/workers/src/lib/asr-keyterms.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEED_CV_PATH = resolve(
  here,
  "../../../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

const T = "00000000-0000-4000-8000-0000c2f70a01";
const BU = "00000000-0000-4000-8000-0000c2f70a02";
const MEMBERSHIP = "00000000-0000-4000-8000-0000c2f70a03";
const POSITION = "00000000-0000-4000-8000-0000c2f70a04";
const JD = "00000000-0000-4000-8000-0000c2f70a05";
const REQ_POSTED = "00000000-0000-4000-8000-0000c2f70a06";
const REQ_APPROVED = "00000000-0000-4000-8000-0000c2f70a07";
const PERSON_REJ = "00000000-0000-4000-8000-0000c2f70a11";
const CAND_REJ = "00000000-0000-4000-8000-0000c2f70a12";
const APP_REJ = "00000000-0000-4000-8000-0000c2f70a13";
const PERSON_HR = "00000000-0000-4000-8000-0000c2f70a21";
const CAND_HR = "00000000-0000-4000-8000-0000c2f70a22";
const APP_HR = "00000000-0000-4000-8000-0000c2f70a23";
const PERSON_HIRED = "00000000-0000-4000-8000-0000c2f70a31";
const CAND_HIRED = "00000000-0000-4000-8000-0000c2f70a32";
const APP_HIRED = "00000000-0000-4000-8000-0000c2f70a33";
const PERSON_STALE = "00000000-0000-4000-8000-0000c2f70a41";
const CAND_STALE = "00000000-0000-4000-8000-0000c2f70a42";
const APP_STALE = "00000000-0000-4000-8000-0000c2f70a43";

const TENANT_SLUG = "synth-c2f7-policy";
const SLUG_APPROVED = "c2f7-approved-req";
const REJECTED_EMAIL = "rejected.c2f7@hireops-dev.local";
const TEST_USER_EMAIL_FOR_FK = "test-fnd15b@hireops-dev.local";
let TEST_USER_FOR_FK: string;
let STORAGE_KEY: string;

const log = createLogger({ level: "error" });

function caller(roles: string[], tenantId: string | null = T) {
  const ctx: HonoTRPCContext = {
    tenantId,
    userId: TEST_USER_FOR_FK,
    roles,
    claims: tenantId
      ? { sub: TEST_USER_FOR_FK, tid: tenantId, tenant_slug: TENANT_SLUG, roles }
      : { sub: TEST_USER_FOR_FK },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-c2f7-${randomUUID()}`,
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
    assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  assert.fail(`${what}: expected ${code}, but the call succeeded`);
}

async function settingsRow(): Promise<Record<string, unknown>> {
  const [row] = await poolSql<{ settings: Record<string, unknown> | null }[]>`
    SELECT settings FROM public.tenants WHERE id = ${T}
  `;
  return row?.settings ?? {};
}

async function setBlock(key: string, value: unknown): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)
    WHERE id = ${T}
  `;
}

async function dropBlock(key: string): Promise<void> {
  await poolSql`UPDATE public.tenants SET settings = settings - ${key}::text WHERE id = ${T}`;
}

async function auditCount(action: string): Promise<number> {
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

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.offers WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.ai_score_outbox WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.requisition_state_transitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${T}`;
}

function applyInput(requisitionId: string, email: string) {
  return {
    requisitionId,
    resumeUploadKey: STORAGE_KEY,
    applicant: { fullName: "Policy Applicant", email, phone: "+919800000799" },
    source: "career_site" as const,
    consentVersion: "v1",
  };
}

describe("C2-F7 policy parameters", () => {
  beforeAll(async () => {
    resetStorageClient();
    const [user] = await poolSql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL_FOR_FK}
    `;
    if (!user) throw new Error(`prerequisite: auth user ${TEST_USER_EMAIL_FOR_FK} not found.`);
    TEST_USER_FOR_FK = user.id;

    await cleanup();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings) VALUES (${T}, ${TENANT_SLUG}, 'C2F7 Synth', 'ap-northeast-1', 'active', ${JSON.stringify({ c2f7_sentinel: "keep-me" })}::jsonb)`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${T}, 'C2F7 BU', 'c2f7-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${MEMBERSHIP}, ${T}, ${TEST_USER_FOR_FK}, ARRAY['admin','hr_ops','recruiter']::tenant_role[], 'active', ${BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${POSITION}, ${T}, ${BU}, 'C2F7 Analyst', 'remote', 'Remote-India', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${JD}, ${T}, ${POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public, created_at) VALUES (${REQ_POSTED}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted', true, now() - interval '60 days')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public, public_slug) VALUES (${REQ_APPROVED}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'approved', true, ${SLUG_APPROVED})`;

    // A person rejected 5 days ago (cooling-off fixture).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${PERSON_REJ}, ${T}, 'Rejected C2f7', ${REJECTED_EMAIL}, ${REJECTED_EMAIL})`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_REJ}, ${T}, ${PERSON_REJ}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at) VALUES (${APP_REJ}, ${T}, ${CAND_REJ}, ${REQ_POSTED}, 'career_site', 'recruiter_rejected', now() - interval '5 days')`;

    // An application at hr_round (offer-draft fixture).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${PERSON_HR}, ${T}, 'Offer C2f7', 'offer.c2f7@hireops-dev.local', 'offer.c2f7@hireops-dev.local')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_HR}, ${T}, ${PERSON_HR}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_HR}, ${T}, ${CAND_HR}, ${REQ_POSTED}, 'career_site', 'hr_round')`;

    // A hire: application created 40 days ago, requisition approved 30 days
    // ago, offer accepted now (time-to-fill fixture).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name) VALUES (${PERSON_HIRED}, ${T}, 'Hired C2f7')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_HIRED}, ${T}, ${PERSON_HIRED}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage, created_at) VALUES (${APP_HIRED}, ${T}, ${CAND_HIRED}, ${REQ_POSTED}, 'career_site', 'offer_accepted', now() - interval '40 days')`;
    await poolSql`INSERT INTO public.application_state_transitions (tenant_id, application_id, from_stage, to_stage, transitioned_at) VALUES (${T}, ${APP_HIRED}, 'hr_round', 'offer_accepted', now())`;
    await poolSql`INSERT INTO public.requisition_state_transitions (tenant_id, requisition_id, from_status, to_status, transitioned_at) VALUES (${T}, ${REQ_POSTED}, 'pending_approval', 'approved', now() - interval '30 days')`;

    // A stale never-hired candidate: last activity 30 months ago.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name) VALUES (${PERSON_STALE}, ${T}, 'Stale C2f7')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source, created_at) VALUES (${CAND_STALE}, ${T}, ${PERSON_STALE}, 'career_site', now() - interval '31 months')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage, created_at, updated_at) VALUES (${APP_STALE}, ${T}, ${CAND_STALE}, ${REQ_POSTED}, 'career_site', 'withdrawn', now() - interval '31 months', now() - interval '30 months')`;

    const cv = await readFile(SEED_CV_PATH);
    STORAGE_KEY = `resumes/${T}-c2f7.docx`;
    await getStorageClient().put(STORAGE_KEY, cv, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: get/updatePolicyParameters are admin-only", async () => {
    for (const role of ["recruiter", "hr_head"]) {
      const c = caller([role]);
      await expectCode(c.getPolicyParameters({}), "FORBIDDEN", `${role} get`);
      await expectCode(
        c.updatePolicyParameters({
          block: "offerPolicy",
          value: { defaultExpiryDays: 9, defaultProbationMonths: 3, decisionSlaHours: 24 },
        }),
        "FORBIDDEN",
        `${role} update`,
      );
    }
    assert.equal((await settingsRow()).offerPolicy, undefined, "a refused write stored nothing");
    assert.equal(await auditCount("update_policy_parameters"), 0, "a refused write is not audited");

    const read = await caller(["admin"]).getPolicyParameters({});
    assert.equal(read.offerPolicy.defaultExpiryDays, 7, "unconfigured = platform default");
    assert.equal(read.screeningPolicy.jdCharCap, 12_000);
    assert.equal(read.platform.aiProvider, "anthropic", "PP18 read-only provider shown");
  });

  it("Test 2: admin write persists a sibling block, is audited, and rejects out-of-range", async () => {
    const admin = caller(["admin"]);
    await expectCode(
      admin.updatePolicyParameters({
        block: "offerPolicy",
        value: { defaultExpiryDays: 61, defaultProbationMonths: 3, decisionSlaHours: 24 },
      }),
      "BAD_REQUEST",
      "expiry 61 days",
    );
    assert.equal((await settingsRow()).offerPolicy, undefined);

    const out = await admin.updatePolicyParameters({
      block: "offerPolicy",
      value: { defaultExpiryDays: 14, defaultProbationMonths: 6, decisionSlaHours: 36 },
    });
    assert.deepEqual(out, { ok: true, block: "offerPolicy" });
    const s = await settingsRow();
    assert.equal(s.c2f7_sentinel, "keep-me", "sibling keys survive");
    assert.deepEqual(s.offerPolicy, {
      defaultExpiryDays: 14,
      defaultProbationMonths: 6,
      decisionSlaHours: 36,
    });
    assert.ok((await auditCount("update_policy_parameters")) >= 1, "write audited");
    const read = await admin.getPolicyParameters({});
    assert.equal(read.offerPolicy.decisionSlaHours, 36);
  });

  it("Test 3: acceptingStatuses — an approved req stops resolving when only posted accepts", async () => {
    const pub = caller([], null);
    const ok = await pub.resolvePublicRequisition({
      tenantSlug: TENANT_SLUG,
      reqSlug: SLUG_APPROVED,
    });
    assert.equal(ok.requisitionId, REQ_APPROVED, "default: approved accepts applications");

    await setBlock("screeningPolicy", { acceptingStatuses: ["posted"] });
    await expectCode(
      pub.resolvePublicRequisition({ tenantSlug: TENANT_SLUG, reqSlug: SLUG_APPROVED }),
      "NOT_FOUND",
      "approved req under posted-only policy",
    );
    await expectCode(
      pub.submitApplication(applyInput(REQ_APPROVED, "fresh1.c2f7@hireops-dev.local")),
      "BAD_REQUEST",
      "submit to approved req under posted-only policy",
    );
    await dropBlock("screeningPolicy");
  });

  it("Test 4: re-apply cooling-off after a rejection is honoured by the apply form", async () => {
    const pub = caller([], null);
    await setBlock("screeningPolicy", { reapplyCoolingOffDays: 30 });
    const err = await expectCode(
      pub.submitApplication(applyInput(REQ_APPROVED, REJECTED_EMAIL)),
      "BAD_REQUEST",
      "rejected 5 days ago, 30-day cooling-off",
    );
    assert.match(String(err?.message), /apply to this employer again from \d{4}-\d{2}-\d{2}/);

    await setBlock("screeningPolicy", { reapplyCoolingOffDays: 3 });
    const out = await pub.submitApplication(applyInput(REQ_APPROVED, REJECTED_EMAIL));
    assert.ok(out.applicationId, "3-day cooling-off has passed → applies");
    const [cand] = await poolSql<{ person_id: string }[]>`
      SELECT c.person_id FROM public.applications a
      JOIN public.candidates c ON c.id = a.candidate_id
      WHERE a.id = ${out.applicationId}
    `;
    assert.equal(cand?.person_id, PERSON_REJ, "linked to the same person");
    await dropBlock("screeningPolicy");
  });

  it("Test 5: uploadPolicy.resumeTypes — a PDF-only tenant refuses a stored DOCX CV", async () => {
    await setBlock("uploadPolicy", { resumeTypes: ["pdf"] });
    await expectCode(
      caller([], null).submitApplication(applyInput(REQ_APPROVED, "fresh2.c2f7@hireops-dev.local")),
      "BAD_REQUEST",
      "docx under pdf-only policy",
    );
    await dropBlock("uploadPolicy");
  });

  it("Test 6: offerPolicy drives draftOffer's default expiry and the offer-decision SLA row", async () => {
    // offerPolicy = { 14 d, 6 m, 36 h } from Test 2.
    const before = Date.now();
    const { offerId } = await caller(["admin", "hr_ops", "recruiter"]).draftOffer({
      applicationId: APP_HR,
      baseSalaryInrPaise: 1_200_000_00,
      joiningDate: "2027-01-04",
      location: "Pune",
    });
    const [offer] = await poolSql<{ expiry_at: Date }[]>`
      SELECT expiry_at FROM public.offers WHERE id = ${offerId}
    `;
    const days = (new Date(offer?.expiry_at ?? 0).getTime() - before) / 86_400_000;
    assert.ok(days > 13.9 && days < 14.1, `expiry ≈ 14 days (got ${days})`);

    const audit = await computeExecutiveAudit(poolDb, T);
    const row = audit.slaTable.find((r) => r.key === "offer_decision");
    assert.equal(row?.targetHours, 36);
    assert.match(String(row?.label), /within 36h/);
  });

  it("Test 7: reportPolicy.ttfStart moves the time-to-fill clock", async () => {
    const db = poolDb as unknown as TenantBoundDb;
    const scope = { requisitionId: REQ_POSTED };
    const byApp = await timeToFillStats(db, T, scope);
    assert.equal(byApp.hires_count, 1);
    assert.ok(
      Math.abs(Number(byApp.median_days) - 40) < 0.1,
      `default ≈ 40 d (${byApp.median_days})`,
    );

    await setBlock("reportPolicy", { ttfStart: "requisition_approved" });
    const byReq = await timeToFillStats(db, T, scope);
    assert.ok(
      Math.abs(Number(byReq.median_days) - 30) < 0.1,
      `req-approved ≈ 30 d (${byReq.median_days})`,
    );

    await setBlock("reportPolicy", { ttfEnd: "joined" });
    const joined = await timeToFillStats(db, T, scope);
    assert.equal(joined.hires_count, 0, "no onboarding start date → not a hire under 'joined'");
    await dropBlock("reportPolicy");
  });

  it("Test 8: the CV retention register follows talentPoolRetentionMonths", async () => {
    const c = caller(["admin"]);
    const def = await c.listCvsPastRetention({});
    assert.equal(def.retentionMonths, 24);
    const ids = def.items.map((i) => i.candidateId);
    assert.ok(ids.includes(CAND_STALE), "30-month-stale candidate flagged at 24 m");
    assert.ok(!ids.includes(CAND_HIRED), "a hire is never flagged");

    await setBlock("retentionPolicy", { talentPoolRetentionMonths: 36 });
    const wide = await c.listCvsPastRetention({});
    assert.equal(wide.retentionMonths, 36);
    assert.ok(!wide.items.some((i) => i.candidateId === CAND_STALE), "36 m: not yet due");

    await setBlock("retentionPolicy", { talentPoolRetentionMonths: 999 });
    assert.equal((await c.listCvsPastRetention({})).retentionMonths, 60, "clamped to ceiling");
    await dropBlock("retentionPolicy");
    await expectCode(
      c.updateRetentionPolicy({ talentPoolRetentionMonths: 61 }),
      "BAD_REQUEST",
      "61 m",
    );
  });

  it("Test 9: offer defaults are readable by a recruiter; market gap write round-trips", async () => {
    const d = await caller(["recruiter"]).getOfferPolicyDefaults({});
    assert.equal(d.defaultExpiryDays, 14);
    await caller(["admin"]).updatePolicyParameters({
      block: "marketIntelPolicy",
      value: { gapThreshold: 0.8 },
    });
    assert.equal(
      (await caller(["admin"]).getPolicyParameters({})).marketIntelPolicy.gapThreshold,
      0.8,
    );
  });
});

describe("C2-F7 pure consumers", () => {
  it("PP2 risk flags: threshold + compa-ratio rule", () => {
    const base = {
      mustHavePct: 60,
      expectedSalaryInrPaise: 1_150_000n,
      compBandMaxInrPaise: 1_200_000n,
      compBandMinInrPaise: 800_000n,
    };
    assert.deepEqual(computeRiskFlags(base), [], "default: 60% > 50%, under band max");
    const policy = {
      riskSkillMismatchMaxPct: 60,
      riskSalaryRule: "over_compa_ratio" as const,
      riskSalaryCompaRatioPct: 110,
    };
    // midpoint 1,000,000 → 110% = 1,100,000 < 1,150,000
    assert.deepEqual(computeRiskFlags(base, policy), ["skill_mismatch", "salary_gap"]);
    assert.deepEqual(
      computeRiskFlags({ ...base, compBandMinInrPaise: null }, policy),
      ["skill_mismatch"],
      "no band floor → falls back to over-band-max",
    );
  });

  it("PP3 req-health weights rescale components; default weights are byte-identical", () => {
    const input = {
      jd: { hasText: true, hasSummary: false, sectionCount: 0 },
      skills: { count: 3, weightedCount: 3, mustHaveCount: 1 },
      interviewPlan: { configured: false, roundCount: 0 },
      budget: { hasBand: true },
      approvalStatus: "approved",
      pipeline: { candidatesInFlight: 0 },
    };
    const def = computeReqHealth(input);
    assert.deepEqual(computeReqHealth(input, REQ_HEALTH_WEIGHTS), def);
    const heavyBudget = computeReqHealth(input, {
      jd: 10,
      skills: 10,
      mustHaves: 10,
      interviewPlan: 10,
      budget: 40,
      approval: 10,
      pipeline: 10,
    });
    assert.equal(heavyBudget.components.find((c) => c.key === "budget")?.max, 40);
    assert.equal(heavyBudget.components.find((c) => c.key === "budget")?.earned, 40);
    assert.ok(heavyBudget.score > def.score);
  });

  it("PP6 the scoring prompt honours the tenant JD cap", () => {
    const jd = "A".repeat(5000) + "TAIL_MARKER";
    const cv = {
      personal: {},
      total_years_experience: null,
      summary: null,
      current_role: null,
      work_history: [],
      education: [],
      certifications: [],
      languages: [],
      skills: { technical: [], domain: [], soft: [], certifications: [], languages: [] },
      parse_metadata: { confidence_score: 1 },
    } as unknown as ParserOutput;
    const full = buildAIScoringPrompt({
      positionTitle: "X",
      jdDescription: jd,
      jdSkills: [],
      parsedCv: cv,
    });
    assert.ok(full.user.includes("TAIL_MARKER"), "default 12k cap keeps the tail");
    const capped = buildAIScoringPrompt({
      positionTitle: "X",
      jdDescription: jd,
      jdCharCap: 2000,
      jdSkills: [],
      parsedCv: cv,
    });
    assert.ok(!capped.user.includes("TAIL_MARKER"), "2k cap drops it");
  });

  it("PP14 question count stays inside the tenant range and the platform 5–10", () => {
    assert.equal(targetQuestionCount(3, 0), 5);
    assert.equal(targetQuestionCount(3, 0, { min: 7, max: 8 }), 7);
    assert.equal(targetQuestionCount(12, 0, { min: 7, max: 8 }), 8);
    assert.equal(targetQuestionCount(12, 0, { min: 2, max: 40 }), 10, "platform ceiling");
  });

  it("PP16 the tenant glossary is appended after the interview's own names", () => {
    const terms = buildInterviewKeyterms({
      tenantDisplayName: "Acme",
      candidateName: null,
      panelNames: [],
      positionTitle: "Analyst",
      glossary: ["P2P", "SAP S/4HANA"],
    });
    // Names first (whole + parts — the ASR client de-duplicates), glossary last.
    assert.deepEqual(terms.slice(-2), ["P2P", "SAP S/4HANA"]);
    assert.ok(terms.indexOf("Analyst") < terms.indexOf("P2P"));
  });

  it("PP8 dedup match modes", async () => {
    const A = { id: "a" };
    const B = { id: "b" };
    const e = async () => A;
    const pB = async () => B;
    const pA = async () => A;
    const none = async () => null;
    assert.equal(await decideDedupMatch("email_or_phone", none, pB), B);
    assert.equal(await decideDedupMatch("email", none, pB), null);
    assert.equal(await decideDedupMatch("phone", e, none), null);
    assert.equal(await decideDedupMatch("email_and_phone", e, pB), null, "different people");
    assert.equal(await decideDedupMatch("email_and_phone", e, pA), A);
  });
});
