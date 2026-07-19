/**
 * CAND-03 — candidate self-service profile + notifications feed.
 *
 * Covers the four new candidateProcedure procedures + the pure notification
 * display map:
 *   1. candidateGetProfile — reads the caller's own profile from the canonical
 *      sources (persons + candidates.parsed_skills + latest application salary);
 *      person-scoped (B never sees A's profile).
 *   2. candidateUpdateProfile — persists phone/location → persons; summaries →
 *      candidates; skills/notice → parsed_skills (shallow-merged, preserving
 *      other keys); salary → LIVE applications only (terminal apps untouched);
 *      echoes the fresh profile. Cross-person edits never bleed.
 *   3. candidateListMyNotifications — a person-scoped read of REAL
 *      candidate-directed notification_outbox rows (by candidate id OR email for
 *      pre-account rows); excludes recruiter-directed + cancelled rows; maps
 *      title/category from the template key; computes unreadCount.
 *   4. candidateMarkNotificationsRead — marks unread → read, idempotent,
 *      person-scoped.
 *   5. displayForCandidateNotification — the pure map (known + unknown keys).
 *
 * Two candidates are REAL Supabase auth users so candidateProcedure resolves a
 * live identity; reads/writes go through appRouter.createCaller with a
 * synthetic HonoTRPCContext whose userId is the candidate's auth user id.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";
import { displayForCandidateNotification } from "../src/lib/candidate-notifications";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
}

// CAND-03 synth namespace ('a043' marker) — valid v4-format UUIDs, distinct
// from cand-01 ('a04') and cand-02 ('a042').
const CT_TENANT = "00000000-0000-4000-8000-0000000a043a";
const CT_BU = "00000000-0000-4000-8000-0000000a043b";
const CT_MEMBERSHIP = "00000000-0000-4000-8000-0000000a043c";
const CT_POSITION = "00000000-0000-4000-8000-0000000a043d";
const CT_POSITION2 = "00000000-0000-4000-8000-0000000a0430";
const CT_JD = "00000000-0000-4000-8000-0000000a043e";
const CT_JD2 = "00000000-0000-4000-8000-0000000a0431";
const CT_REQ = "00000000-0000-4000-8000-0000000a043f";
const CT_REQ2 = "00000000-0000-4000-8000-0000000a0432";
const PERSON_A = "00000000-0000-4000-8000-0000000a0433";
const PERSON_B = "00000000-0000-4000-8000-0000000a0434";
const CAND_A = "00000000-0000-4000-8000-0000000a0435";
const CAND_B = "00000000-0000-4000-8000-0000000a0436";
const APP_A_LIVE = "00000000-0000-4000-8000-0000000a0437";
const APP_A_TERMINAL = "00000000-0000-4000-8000-0000000a0438";
const APP_B = "00000000-0000-4000-8000-0000000a0439";
const NOTIF_A_INT = "00000000-0000-4000-8000-0000000a0441";
const NOTIF_A_STAGE = "00000000-0000-4000-8000-0000000a0442";
const NOTIF_A_ACT = "00000000-0000-4000-8000-0000000a0443";
const NOTIF_A_CANCELLED = "00000000-0000-4000-8000-0000000a0444";
const NOTIF_A_RECRUITER = "00000000-0000-4000-8000-0000000a0445";
const NOTIF_B_INT = "00000000-0000-4000-8000-0000000a0446";

const EMAIL_A = "cand-a-cand03@hireops-dev.local";
const EMAIL_B = "cand-b-cand03@hireops-dev.local";
const CAND_PASSWORD = "cand03-test-password-do-not-reuse";

const log = createLogger({ level: "error" });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let authIdA: string;
let authIdB: string;
let recruiterUserId: string;

async function getRecruiterUserId(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return decodeJwt(data.session.access_token).sub as string;
}

async function createCandidateUser(email: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email,
    password: CAND_PASSWORD,
    email_confirm: true,
  });
  let id = created.data?.user?.id ?? null;
  if (!id) {
    const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    id = list.data?.users.find((u) => u.email === email)?.id ?? null;
  }
  if (!id) throw new Error(`could not create/find auth user ${email}`);
  return id;
}

function makeCaller(userId: string) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: { sub: userId },
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-cand03-${randomUUID()}`,
    userAgent: "cand03-test",
    ipAddress: "127.0.0.1",
  };
  return appRouter.createCaller(ctx);
}

async function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof TRPCError, `${label}: expected a TRPCError`);
  assert.equal((thrown as TRPCError).code, code, `${label}: expected ${code}`);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${CT_TENANT}`;
}

describe("CAND-03 candidate profile + notifications", () => {
  beforeAll(async () => {
    recruiterUserId = await getRecruiterUserId();
    authIdA = await createCandidateUser(EMAIL_A);
    authIdB = await createCandidateUser(EMAIL_B);
    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${CT_TENANT}, 'synth-cand-03', 'Candidate-03 Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${CT_BU}, ${CT_TENANT}, 'CT3 BU', 'ct3-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${CT_MEMBERSHIP}, ${CT_TENANT}, ${recruiterUserId}, ARRAY['recruiter']::tenant_role[], 'active', ${CT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${CT_POSITION}, ${CT_TENANT}, ${CT_BU}, 'Senior Backend Engineer', 'hybrid', 'Bengaluru', true)`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${CT_POSITION2}, ${CT_TENANT}, ${CT_BU}, 'Staff Engineer', 'hybrid', 'Pune', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${CT_JD}, ${CT_TENANT}, ${CT_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${CT_JD2}, ${CT_TENANT}, ${CT_POSITION2}, 1, '# JD2', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${CT_REQ}, ${CT_TENANT}, ${CT_POSITION}, ${CT_JD}, ${CT_MEMBERSHIP}, ${CT_MEMBERSHIP}, 'posted', true)`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${CT_REQ2}, ${CT_TENANT}, ${CT_POSITION2}, ${CT_JD2}, ${CT_MEMBERSHIP}, ${CT_MEMBERSHIP}, 'posted', true)`;

    // Person A seeded with a phone + country; candidate A with parsed_skills
    // carrying pre-existing keys we must PRESERVE on merge.
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, location_city, location_country) VALUES (${PERSON_A}, ${CT_TENANT}, 'Aanya Rao', ${EMAIL_A}, ${EMAIL_A}, '+919812340001', 'Bengaluru', 'IN')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, phone_primary, location_country) VALUES (${PERSON_B}, ${CT_TENANT}, 'Bharat Singh', ${EMAIL_B}, ${EMAIL_B}, '+919812340002', 'IN')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source, parsed_skills) VALUES (${CAND_A}, ${CT_TENANT}, ${PERSON_A}, 'career_site', ${JSON.stringify({ personal: { full_name: "Aanya Rao" }, skills: ["Java", "Spring"], notice_period_days: 90, parse_metadata: { source: "seed" } })}::jsonb)`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_B}, ${CT_TENANT}, ${PERSON_B}, 'career_site')`;

    // A: one LIVE application (shortlisted) + one TERMINAL (offer_accepted) to
    // prove salary writes only touch live apps. B: one live application.
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_A_LIVE}, ${CT_TENANT}, ${CAND_A}, ${CT_REQ}, 'career_site', 'shortlisted')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_A_TERMINAL}, ${CT_TENANT}, ${CAND_A}, ${CT_REQ2}, 'career_site', 'offer_accepted')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_B}, ${CT_TENANT}, ${CAND_B}, ${CT_REQ}, 'career_site', 'shortlisted')`;

    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${CT_TENANT}, ${PERSON_A}, ${authIdA}, 'active', now())`;
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${CT_TENANT}, ${PERSON_B}, ${authIdB}, 'active', now())`;

    // Notifications — A: interview (by candidate id, with subject) + stage
    // advance (by candidate id) + activation (email-only, pre-account) +
    // a cancelled row (must be hidden) + a recruiter-directed row (must be
    // hidden). B: one interview row.
    await poolSql`INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, recipient_candidate_id, template_key, subject, status, created_at) VALUES (${NOTIF_A_INT}, ${CT_TENANT}, 'candidate', ${EMAIL_A}, ${CAND_A}, 'candidate.interview_invitation', 'Interview scheduled: Round 2 Technical', 'sent', now() - interval '1 hour')`;
    await poolSql`INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, recipient_candidate_id, template_key, status, created_at) VALUES (${NOTIF_A_STAGE}, ${CT_TENANT}, 'candidate', ${EMAIL_A}, ${CAND_A}, 'candidate.stage_advanced', 'sent', now() - interval '2 hours')`;
    await poolSql`INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, template_key, status, created_at) VALUES (${NOTIF_A_ACT}, ${CT_TENANT}, 'candidate', ${EMAIL_A}, 'candidate.account_activation', 'sent', now() - interval '3 days')`;
    await poolSql`INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, recipient_candidate_id, template_key, status, created_at) VALUES (${NOTIF_A_CANCELLED}, ${CT_TENANT}, 'candidate', ${EMAIL_A}, ${CAND_A}, 'candidate.interview_cancelled', 'cancelled', now() - interval '4 hours')`;
    await poolSql`INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, template_key, status, created_at) VALUES (${NOTIF_A_RECRUITER}, ${CT_TENANT}, 'recruiter', ${EMAIL_A}, 'recruiter.sla_imminent', 'sent', now())`;
    await poolSql`INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, recipient_candidate_id, template_key, status, created_at) VALUES (${NOTIF_B_INT}, ${CT_TENANT}, 'candidate', ${EMAIL_B}, ${CAND_B}, 'candidate.interview_invitation', 'sent', now())`;
  });

  afterAll(async () => {
    await cleanup();
    await admin.auth.admin.deleteUser(authIdA).catch(() => undefined);
    await admin.auth.admin.deleteUser(authIdB).catch(() => undefined);
    await poolSql.end({ timeout: 10 });
  });

  it("1. candidateGetProfile reads the caller's own profile, person-scoped", async () => {
    const a = await makeCaller(authIdA).candidateGetProfile();
    assert.equal(a.profile.fullName, "Aanya Rao");
    assert.equal(a.profile.email, EMAIL_A);
    assert.equal(a.profile.phone, "+919812340001");
    assert.equal(a.profile.locationCity, "Bengaluru");
    assert.equal(a.profile.locationCountry, "IN");
    assert.deepEqual(a.profile.skills, ["Java", "Spring"]);
    assert.equal(a.profile.noticePeriodDays, 90);
    assert.equal(a.profile.expectedSalaryInrPaise, null, "no salary captured yet");

    const b = await makeCaller(authIdB).candidateGetProfile();
    assert.equal(b.profile.fullName, "Bharat Singh", "B sees only their own profile");
    assert.deepEqual(b.profile.skills, [], "B has no parsed skills");
  });

  it("2. candidateUpdateProfile persists to the canonical sources", async () => {
    const res = await makeCaller(authIdA).candidateUpdateProfile({
      phone: "+91 90000 12345",
      locationCity: "Chennai",
      locationCountry: "in",
      experienceSummary: "8 years in backend engineering.",
      educationSummary: "B.Tech CS, IIT Madras (2016)",
      skills: ["Java", "Spring Boot", "Kafka"],
      noticePeriodDays: 45,
      expectedSalaryInrPaise: 3_600_000 * 100,
    });
    assert.equal(res.ok, true);
    assert.equal(res.profile.locationCity, "Chennai");
    assert.equal(res.profile.locationCountry, "IN", "country upper-cased");
    assert.equal(res.profile.experienceSummary, "8 years in backend engineering.");
    assert.equal(res.profile.educationSummary, "B.Tech CS, IIT Madras (2016)");
    assert.deepEqual(res.profile.skills, ["Java", "Spring Boot", "Kafka"]);
    assert.equal(res.profile.noticePeriodDays, 45);
    assert.equal(res.profile.expectedSalaryInrPaise, 3_600_000 * 100);

    // Phone normalised on persons.
    const [p] = await poolSql<
      { phone_primary: string; phone_normalised: string; location_country: string }[]
    >`
      SELECT phone_primary, phone_normalised, location_country FROM public.persons WHERE id = ${PERSON_A}`;
    assert.equal(p?.phone_primary, "+91 90000 12345");
    assert.equal(p?.phone_normalised, "919000012345");
    assert.equal(p?.location_country, "IN");

    // parsed_skills shallow-merged — pre-existing keys preserved.
    const [c] = await poolSql<{ parsed_skills: Record<string, unknown> }[]>`
      SELECT parsed_skills FROM public.candidates WHERE id = ${CAND_A}`;
    const ps = c!.parsed_skills as Record<string, unknown>;
    assert.deepEqual(ps.skills, ["Java", "Spring Boot", "Kafka"]);
    assert.equal(ps.notice_period_days, 45);
    assert.ok(ps.personal, "pre-existing 'personal' key preserved");
    assert.ok(ps.parse_metadata, "pre-existing 'parse_metadata' key preserved");
  });

  it("3. salary writes touch only LIVE applications (terminal untouched)", async () => {
    const [live] = await poolSql<{ v: string | null }[]>`
      SELECT expected_salary_inr_paise::text AS v FROM public.applications WHERE id = ${APP_A_LIVE}`;
    const [term] = await poolSql<{ v: string | null }[]>`
      SELECT expected_salary_inr_paise::text AS v FROM public.applications WHERE id = ${APP_A_TERMINAL}`;
    assert.equal(live?.v, String(3_600_000 * 100), "live app got the expectation");
    assert.equal(term?.v, null, "terminal (accepted) app left untouched");
  });

  it("4. candidateUpdateProfile is person-scoped (B's edit never touches A)", async () => {
    await makeCaller(authIdB).candidateUpdateProfile({ locationCity: "Hyderabad" });
    const a = await makeCaller(authIdA).candidateGetProfile();
    assert.equal(a.profile.locationCity, "Chennai", "A unchanged by B's edit");
    const b = await makeCaller(authIdB).candidateGetProfile();
    assert.equal(b.profile.locationCity, "Hyderabad");
  });

  it("5. clearing a field with null persists as null", async () => {
    const res = await makeCaller(authIdA).candidateUpdateProfile({ experienceSummary: null });
    assert.equal(res.profile.experienceSummary, null);
  });

  it("6. candidateListMyNotifications returns real candidate rows, person-scoped", async () => {
    const a = await makeCaller(authIdA).candidateListMyNotifications();
    const ids = a.items.map((i) => i.id);
    assert.ok(ids.includes(NOTIF_A_INT), "interview row present");
    assert.ok(ids.includes(NOTIF_A_STAGE), "stage row present");
    assert.ok(ids.includes(NOTIF_A_ACT), "activation (email-only) row present");
    assert.ok(!ids.includes(NOTIF_A_CANCELLED), "cancelled row hidden");
    assert.ok(!ids.includes(NOTIF_A_RECRUITER), "recruiter-directed row hidden");
    assert.ok(!ids.includes(NOTIF_B_INT), "B's row not visible to A");

    const intRow = a.items.find((i) => i.id === NOTIF_A_INT)!;
    assert.equal(intRow.category, "interview");
    assert.equal(intRow.title, "Interview scheduled");
    assert.equal(
      intRow.body,
      "Interview scheduled: Round 2 Technical",
      "real subject used as body",
    );
    assert.equal(intRow.read, false);

    const stageRow = a.items.find((i) => i.id === NOTIF_A_STAGE)!;
    assert.equal(stageRow.category, "application");
    assert.equal(stageRow.body, "Your application moved to the next stage.", "fallback body");

    assert.equal(a.unreadCount, 3, "three unread candidate rows");

    // newest-first ordering.
    assert.equal(a.items[0]!.id, NOTIF_A_INT, "newest first");
  });

  it("7. candidateMarkNotificationsRead marks unread → read, idempotent", async () => {
    const first = await makeCaller(authIdA).candidateMarkNotificationsRead({});
    assert.equal(first.markedCount, 3, "all three unread marked");
    const after = await makeCaller(authIdA).candidateListMyNotifications();
    assert.equal(after.unreadCount, 0);
    assert.ok(
      after.items.every((i) => i.read),
      "every row read",
    );

    const again = await makeCaller(authIdA).candidateMarkNotificationsRead({});
    assert.equal(again.markedCount, 0, "idempotent — nothing left to mark");

    // B's notifications remain unread (person-scoped).
    const b = await makeCaller(authIdB).candidateListMyNotifications();
    assert.equal(b.unreadCount, 1, "B's row untouched by A's mark-read");
  });

  it("8. displayForCandidateNotification maps known + unknown keys", () => {
    assert.equal(
      displayForCandidateNotification("candidate.interview_invitation").category,
      "interview",
    );
    assert.equal(displayForCandidateNotification("candidate.offer_extended").category, "offer");
    assert.equal(
      displayForCandidateNotification("candidate.account_activation").category,
      "account",
    );
    // Unknown key degrades gracefully.
    const unknown = displayForCandidateNotification("candidate.brand_new_event");
    assert.equal(unknown.title, "Brand new event");
    assert.equal(unknown.category, "general");
  });
});
