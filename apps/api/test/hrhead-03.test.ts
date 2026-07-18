/**
 * HRHEAD-03 — Governance page + Executive Audit (persona pass 3/3).
 *
 * Coverage:
 *   Test 1: pure helpers — resolveScreeningPrivacy / resolveFeedbackSharing
 *           merge+defaults; resolveCandidateMasking matrix (recruiter masked
 *           before the gate, unmasked at tech_interview, hr_head/admin always
 *           see through, policy-off never masks); candidateMaskLabel format.
 *   Test 2: screeningPrivacy masking via the REAL reads — getCandidateById +
 *           listCandidates return a masked name / nulled contact for a
 *           recruiter on an early-stage candidate, unmasked for hr_head/admin,
 *           and unmasked for everyone once the candidate is at tech_interview.
 *   Test 3: feedbackSharing via the candidate portal read — ON surfaces the
 *           strengths summary + recommendation on a completed interview; OFF
 *           returns both null; numeric scores are NEVER present either way.
 *   Test 4: governance settings are gated (recruiter FORBIDDEN read + write)
 *           and the sibling merge preserves aiSettings / biasLexicon verbatim.
 *   Test 5: getGovernanceRiskFlags — the unrealistic-must-haves rule fires on
 *           the seeded 6-required-skill req; the payload shape is asserted.
 *   Test 6: getExecutiveAudit — every compliance component value ∈ [0,1] with
 *           its documented weight, the score ∈ [0,100], five SLA rows.
 *
 * Seeds a synthetic requisition + candidates INSIDE kyndryl-poc (the JWT's
 * tenant) so the role-bearing reads run against controllable data; a synthetic
 * candidate account exercises the portal path via createCaller. kyndryl-poc's
 * settings jsonb is snapshotted and restored verbatim; all seed rows are
 * cleaned up in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import {
  resolveScreeningPrivacy,
  resolveFeedbackSharing,
  resolveCandidateMasking,
  candidateMaskLabel,
  defaultScreeningPrivacy,
  defaultFeedbackSharing,
  type ScreeningPrivacy,
  type FeedbackSharing,
  type GetCandidateByIdOutput,
  type ListCandidatesOutput,
  type GetGovernanceRiskFlagsOutput,
  type GetExecutiveAuditOutput,
  type CandidateListMyInterviewsOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const HR_HEAD = "hrhead1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// hrhead-03 synth namespace (groom-safe — deleted in afterAll).
const N = "00000000-0000-4000-8000-0000c0f30b";
const POSITION = `${N}01`;
const JD = `${N}02`;
const REQ = `${N}03`;
const PERSON_EARLY = `${N}04`;
const CAND_EARLY = `${N}05`;
const APP_EARLY = `${N}06`;
const PERSON_LATE = `${N}07`;
const CAND_LATE = `${N}08`;
const APP_LATE = `${N}09`;
const PERSON_CAND = `${N}0a`;
const CAND_CAND = `${N}0b`;
const APP_CAND = `${N}0c`;
const INTERVIEW = `${N}0d`;
const FEEDBACK = `${N}0e`;
const CAND_AUTH = `${N}0f`;

const log = createLogger({ base: { service: "hrhead-03-test" } });

let adminJwt: string;
let recruiterJwt: string;
let hrHeadJwt: string;
let tenantId: string;
let membershipId: string;
let buId: string;
let originalSettings: unknown;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
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

async function setScreeningPrivacy(block: Record<string, unknown>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('screeningPrivacy', ${JSON.stringify(block)}::jsonb)
    WHERE id = ${tenantId}
  `;
}
async function setFeedbackSharing(block: Record<string, unknown>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('feedbackSharing', ${JSON.stringify(block)}::jsonb)
    WHERE id = ${tenantId}
  `;
}

/** Candidate-tier caller (createCaller path — the portal identity tier). */
function candidateCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-hrhead03-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.interview_feedback WHERE tenant_id = ${tenantId} AND id = ${FEEDBACK}`;
  await poolSql`DELETE FROM public.interviews WHERE tenant_id = ${tenantId} AND id = ${INTERVIEW}`;
  await poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${tenantId} AND person_id = ${PERSON_CAND}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${tenantId} AND id IN (${APP_EARLY}, ${APP_LATE}, ${APP_CAND})`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${tenantId} AND id IN (${CAND_EARLY}, ${CAND_LATE}, ${CAND_CAND})`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${tenantId} AND id IN (${PERSON_EARLY}, ${PERSON_LATE}, ${PERSON_CAND})`;
  await poolSql`DELETE FROM public.jd_skills WHERE tenant_id = ${tenantId} AND jd_version_id = ${JD}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${tenantId} AND id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${tenantId} AND id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${tenantId} AND id = ${POSITION}`;
}

describe("HRHEAD-03 — Governance & Executive Audit", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt, hrHeadJwt] = await Promise.all([
      signIn(ADMIN),
      signIn(RECRUITER),
      signIn(HR_HEAD),
    ]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip our two blocks (afterAll restores verbatim).
    await poolSql`
      UPDATE public.tenants
      SET settings = settings - 'screeningPrivacy' - 'feedbackSharing'
      WHERE id = ${tenantId}
    `;

    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE tenant_id = ${tenantId} AND status = 'active'
      LIMIT 1
    `;
    if (!m) throw new Error("no active membership in kyndryl-poc");
    membershipId = m.id;
    const [b] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.business_units WHERE tenant_id = ${tenantId} LIMIT 1
    `;
    if (!b) throw new Error("no business unit in kyndryl-poc");
    buId = b.id;

    await cleanup();

    // Synthetic requisition (posted → an "open" req for the rule engine).
    const positionTitle = `HRHEAD-03 Governance Engineer ${randomUUID().slice(0, 8)}`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${buId}, ${positionTitle}, 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status, summary)
      VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved', 'Governance engineer.')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public, public_slug)
      VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${membershipId}, ${membershipId},
              'posted', true, ${"hrhead03-" + randomUUID().slice(0, 8)})
    `;
    // Six REQUIRED skills → the unrealistic-must-haves rule fires (>5).
    for (let i = 0; i < 6; i++) {
      await poolSql`
        INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, is_required, weight)
        VALUES (${tenantId}, ${JD}, ${"Required Skill " + i}, true, 1.0)
      `;
    }

    // Early-stage candidate (recruiter_review — before the mask gate).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, phone_primary) VALUES (${PERSON_EARLY}, ${tenantId}, 'Early Screen Candidate', 'early-hrhead03@example.test', '+91 90000 00001')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_EARLY}, ${tenantId}, ${PERSON_EARLY}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_EARLY}, ${tenantId}, ${CAND_EARLY}, ${REQ}, 'career_site', 'recruiter_review')`;

    // Late-stage candidate (tech_interview — at the gate, always unmasked).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, phone_primary) VALUES (${PERSON_LATE}, ${tenantId}, 'Late Stage Candidate', 'late-hrhead03@example.test', '+91 90000 00002')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_LATE}, ${tenantId}, ${PERSON_LATE}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_LATE}, ${tenantId}, ${CAND_LATE}, ${REQ}, 'career_site', 'tech_interview')`;

    // Candidate-account holder with a completed interview + submitted feedback.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary) VALUES (${PERSON_CAND}, ${tenantId}, 'Portal Candidate', 'portal-hrhead03@example.test')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_CAND}, ${tenantId}, ${PERSON_CAND}, 'career_site')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_CAND}, ${tenantId}, ${CAND_CAND}, ${REQ}, 'career_site', 'tech_interview')`;
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${tenantId}, ${PERSON_CAND}, ${CAND_AUTH}, 'active', now())`;
    await poolSql`
      INSERT INTO public.interviews
        (id, tenant_id, application_id, requisition_id, round_number, round_name, status, mode, scheduled_start, scheduled_end, duration_minutes, created_by_membership_id)
      VALUES (${INTERVIEW}, ${tenantId}, ${APP_CAND}, ${REQ}, 1, 'Tech Screen', 'completed', 'video',
              now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 60, ${membershipId})
    `;
    await poolSql`
      INSERT INTO public.interview_feedback
        (id, tenant_id, interview_id, membership_id, scorecard, strengths, concerns, recommendation, submitted_at)
      VALUES (${FEEDBACK}, ${tenantId}, ${INTERVIEW}, ${membershipId},
              ${JSON.stringify({ system_design: 4, coding: 5 })}::jsonb,
              'Strong system-design instincts; clear communicator.', 'Light on Kafka.',
              'yes', now() - interval '2 days')
    `;
  });

  afterAll(async () => {
    try {
      await poolSql`
        UPDATE public.tenants SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      /* best-effort */
    }
    try {
      await cleanup();
    } catch {
      /* best-effort — groom sweep picks up residue */
    }
  });

  it("Test 1: pure helpers — resolve merges, masking matrix, label format", () => {
    // resolve defaults + merge.
    assert.deepEqual(resolveScreeningPrivacy(undefined), defaultScreeningPrivacy());
    assert.equal(defaultScreeningPrivacy().hideCandidateName, false);
    assert.equal(resolveScreeningPrivacy({ hideCandidateName: true }).hideCandidateName, true);
    assert.equal(resolveScreeningPrivacy("garbage").hideContactInfo, false);
    assert.deepEqual(resolveFeedbackSharing(undefined), defaultFeedbackSharing());
    assert.equal(resolveFeedbackSharing({ shareRecommendation: true }).shareRecommendation, true);

    const privacyOn: ScreeningPrivacy = {
      version: 1,
      hideCandidateName: true,
      hideContactInfo: true,
    };

    // Recruiter, early stage → both masked.
    const rEarly = resolveCandidateMasking({
      roles: ["recruiter"],
      stage: "recruiter_review",
      privacy: privacyOn,
    });
    assert.equal(rEarly.maskName, true);
    assert.equal(rEarly.maskContact, true);

    // Recruiter, at tech_interview → gate lifts, nothing masked.
    const rLate = resolveCandidateMasking({
      roles: ["recruiter"],
      stage: "tech_interview",
      privacy: privacyOn,
    });
    assert.equal(rLate.maskName, false);
    assert.equal(rLate.maskContact, false);

    // hr_head + admin always see through, even early.
    for (const role of ["hr_head", "admin"]) {
      const d = resolveCandidateMasking({
        roles: [role],
        stage: "recruiter_review",
        privacy: privacyOn,
      });
      assert.equal(d.maskName, false, `${role} sees name`);
      assert.equal(d.maskContact, false, `${role} sees contact`);
    }

    // A recruiter who is ALSO admin sees through.
    const mixed = resolveCandidateMasking({
      roles: ["recruiter", "admin"],
      stage: "recruiter_review",
      privacy: privacyOn,
    });
    assert.equal(mixed.maskName, false);

    // Policy off → never masks.
    const off = resolveCandidateMasking({
      roles: ["recruiter"],
      stage: "recruiter_review",
      privacy: defaultScreeningPrivacy(),
    });
    assert.equal(off.maskName, false);
    assert.equal(off.maskContact, false);

    // Label format.
    const label = candidateMaskLabel("00000000-0000-4000-8000-0000c0f30b05");
    assert.match(label, /^Candidate #[0-9A-F]{8}$/);
  });

  it("Test 2: screeningPrivacy masks triage/drawer reads for recruiter, not hr_head/admin, and lifts at the gate", async () => {
    await setScreeningPrivacy({ hideCandidateName: true, hideContactInfo: true });

    // getCandidateById(early) as recruiter → masked name + nulled contact.
    const recEarly = await trpcQuery<GetCandidateByIdOutput>(
      "getCandidateById",
      { id: CAND_EARLY },
      recruiterJwt,
    );
    assert.ok(!isErr(recEarly), `recruiter read failed: ${JSON.stringify(recEarly)}`);
    assert.match(recEarly.result.data.person.fullName ?? "", /^Candidate #/, "name masked");
    assert.equal(recEarly.result.data.person.email, null, "email masked");
    assert.equal(recEarly.result.data.person.phone, null, "phone masked");

    // Same read as hr_head → unmasked.
    const hrEarly = await trpcQuery<GetCandidateByIdOutput>(
      "getCandidateById",
      { id: CAND_EARLY },
      hrHeadJwt,
    );
    assert.ok(!isErr(hrEarly));
    assert.equal(
      hrEarly.result.data.person.fullName,
      "Early Screen Candidate",
      "hr_head sees name",
    );
    assert.ok(hrEarly.result.data.person.email, "hr_head sees email");

    // Same read as admin → unmasked.
    const adminEarly = await trpcQuery<GetCandidateByIdOutput>(
      "getCandidateById",
      { id: CAND_EARLY },
      adminJwt,
    );
    assert.ok(!isErr(adminEarly));
    assert.equal(
      adminEarly.result.data.person.fullName,
      "Early Screen Candidate",
      "admin sees name",
    );

    // Late-stage candidate → recruiter sees unmasked (gate lifted).
    const recLate = await trpcQuery<GetCandidateByIdOutput>(
      "getCandidateById",
      { id: CAND_LATE },
      recruiterJwt,
    );
    assert.ok(!isErr(recLate));
    assert.equal(recLate.result.data.person.fullName, "Late Stage Candidate", "gate lifted");
    assert.ok(recLate.result.data.person.email, "contact visible past gate");

    // listCandidates(filter req) as recruiter → early masked, late unmasked.
    const list = await trpcQuery<ListCandidatesOutput>(
      "listCandidates",
      { filters: { requisitionId: REQ }, pagination: { limit: 50 }, sort: "recent" },
      recruiterJwt,
    );
    assert.ok(!isErr(list), `list failed: ${JSON.stringify(list)}`);
    const early = list.result.data.rows.find((r) => r.candidateId === CAND_EARLY);
    const late = list.result.data.rows.find((r) => r.candidateId === CAND_LATE);
    assert.ok(early, "early row present");
    assert.ok(late, "late row present");
    assert.match(early!.fullName ?? "", /^Candidate #/, "list early masked");
    assert.equal(early!.email, null, "list early contact masked");
    assert.equal(late!.fullName, "Late Stage Candidate", "list late unmasked");
  });

  it("Test 3: feedbackSharing surfaces summary/recommendation when on, hides when off, never scores", async () => {
    const caller = candidateCaller(CAND_AUTH);

    // ON → summary + recommendation present; no score fields leak.
    await setFeedbackSharing({ shareInterviewSummary: true, shareRecommendation: true });
    const on = (await caller.candidateListMyInterviews()) as CandidateListMyInterviewsOutput;
    const itemOn = on.items.find((i) => i.interviewId === INTERVIEW);
    assert.ok(itemOn, "completed interview present");
    assert.equal(itemOn!.status, "completed");
    assert.match(itemOn!.sharedSummary ?? "", /system-design/i, "summary shared");
    assert.equal(itemOn!.sharedRecommendation, "yes", "recommendation shared");
    // Regression: no score / scorecard field is exposed on the row.
    assert.ok(!("scorecard" in itemOn!), "no scorecard key");
    assert.ok(!("score" in itemOn!), "no score key");
    for (const v of Object.values(itemOn!)) {
      assert.notEqual(v, 4, "no raw competency score leaked");
      assert.notEqual(v, 5, "no raw competency score leaked");
    }

    // OFF → both null.
    await setFeedbackSharing({ shareInterviewSummary: false, shareRecommendation: false });
    const off = (await caller.candidateListMyInterviews()) as CandidateListMyInterviewsOutput;
    const itemOff = off.items.find((i) => i.interviewId === INTERVIEW);
    assert.ok(itemOff);
    assert.equal(itemOff!.sharedSummary, null, "summary hidden");
    assert.equal(itemOff!.sharedRecommendation, null, "recommendation hidden");
  });

  it("Test 4: governance settings gated (recruiter FORBIDDEN) + sibling merge preserves neighbours", async () => {
    // Plant an aiSettings sibling and a sentinel to prove byte-survival.
    await poolSql`
      UPDATE public.tenants
      SET settings = settings
        || jsonb_build_object('aiSettings', jsonb_build_object('version', 1, 'piiMasking', true))
        || jsonb_build_object('hrhead03_sentinel', 'keep-me')
      WHERE id = ${tenantId}
    `;

    // recruiter FORBIDDEN on both read + write.
    const rRead = await trpcQuery("getScreeningPrivacy", {}, recruiterJwt);
    assert.ok(isErr(rRead) && rRead.error.data.code === "FORBIDDEN", "recruiter read forbidden");
    const rWrite = await trpcMutation(
      "updateScreeningPrivacy",
      { hideCandidateName: true },
      recruiterJwt,
    );
    assert.ok(isErr(rWrite) && rWrite.error.data.code === "FORBIDDEN", "recruiter write forbidden");

    // hr_head can write screeningPrivacy; feedbackSharing saves independently.
    const w1 = await trpcMutation<{ ok: true; screeningPrivacy: ScreeningPrivacy }>(
      "updateScreeningPrivacy",
      { hideCandidateName: true, hideContactInfo: false },
      hrHeadJwt,
    );
    assert.ok(!isErr(w1), `hr_head write failed: ${JSON.stringify(w1)}`);
    assert.equal(w1.result.data.screeningPrivacy.hideCandidateName, true);

    const w2 = await trpcMutation<{ ok: true; feedbackSharing: FeedbackSharing }>(
      "updateFeedbackSharing",
      { shareInterviewSummary: true, shareRecommendation: false },
      hrHeadJwt,
    );
    assert.ok(!isErr(w2));
    assert.equal(w2.result.data.feedbackSharing.shareInterviewSummary, true);

    // Neighbours survived.
    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    const s = row!.settings;
    assert.equal(s["hrhead03_sentinel"], "keep-me", "sibling sentinel survives");
    assert.equal(
      (s["aiSettings"] as Record<string, unknown>)["piiMasking"],
      true,
      "aiSettings survives",
    );
    assert.ok(s["screeningPrivacy"], "screeningPrivacy written");
    assert.ok(s["feedbackSharing"], "feedbackSharing written");

    await poolSql`UPDATE public.tenants SET settings = settings - 'hrhead03_sentinel' WHERE id = ${tenantId}`;
  });

  it("Test 5: getGovernanceRiskFlags fires the unrealistic-must-haves rule + valid shape", async () => {
    const res = await trpcQuery<GetGovernanceRiskFlagsOutput>(
      "getGovernanceRiskFlags",
      undefined,
      adminJwt,
    );
    assert.ok(!isErr(res), `risk flags read failed: ${JSON.stringify(res)}`);
    const data = res.result.data;

    // Shape invariants.
    assert.equal(data.counts.total, data.flags.length, "counts.total matches");
    assert.equal(
      data.counts.high + data.counts.medium + data.counts.low,
      data.flags.length,
      "severity tally matches",
    );
    for (const f of data.flags) {
      assert.ok(["high", "medium", "low"].includes(f.severity), "valid severity");
      assert.ok(f.title.length > 0 && f.consequence.length > 0, "title + consequence present");
    }

    // Our seeded 6-required-skill req MUST fire the unrealistic-must-haves rule.
    const mine = data.flags.find((f) => f.rule === "unrealistic_must_haves" && f.entityId === REQ);
    assert.ok(mine, "unrealistic_must_haves fired for the seeded req");
    assert.equal(mine!.severity, "medium");
    assert.equal(mine!.deepLink, `/requisitions/${REQ}`);
  });

  it("Test 6: getExecutiveAudit — components ∈ [0,1] with weights, score ∈ [0,100], 5 SLA rows", async () => {
    const res = await trpcQuery<GetExecutiveAuditOutput>("getExecutiveAudit", undefined, hrHeadJwt);
    assert.ok(!isErr(res), `exec audit read failed: ${JSON.stringify(res)}`);
    const data = res.result.data;

    assert.equal(data.components.length, 4, "four compliance components");
    let weightSum = 0;
    for (const c of data.components) {
      assert.ok(c.value >= 0 && c.value <= 1, `${c.key} value in [0,1]`);
      assert.ok(Number.isInteger(c.weightPct) && c.weightPct > 0, `${c.key} has a weight`);
      assert.ok(c.sampleSize >= 0, `${c.key} sample non-negative`);
      weightSum += c.weightPct;
    }
    assert.equal(weightSum, 100, "component weights sum to 100");

    assert.ok(
      data.kpis.complianceScore >= 0 && data.kpis.complianceScore <= 100,
      "score in [0,100]",
    );
    assert.equal(data.slaTable.length, 5, "five SLA rows");
    for (const r of data.slaTable) {
      assert.ok(r.targetHours > 0, "target set");
      assert.ok(
        r.withinTargetPct === null || (r.withinTargetPct >= 0 && r.withinTargetPct <= 1),
        "within pct in [0,1] or null",
      );
    }
    assert.equal(data.flagCounts.total, data.flags.length, "flag counts consistent");
  });
});
