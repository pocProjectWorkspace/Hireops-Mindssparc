/**
 * N2a — interview-recording consent, backend.
 *
 * What this suite protects, in order of how expensive it would be to lose:
 *
 *   1. WITHDRAWAL AFTER CONFIRMATION WORKS. This is the regression guard for
 *      the whole design. POST /confirm/:token is SINGLE-USE (the partial
 *      unique on signed_link_uses WHERE successful = true), so consent
 *      captured only there could never be taken back. The separate
 *      POST /confirm/:token/recording-consent route is what makes a
 *      withdrawal expressible, and this suite asserts BOTH halves: the
 *      confirm route still refuses a second use, and the consent route still
 *      accepts one.
 *   2. ABSENCE IS NOT PERMISSION. A candidate who confirms without answering
 *      the recording question writes NO consent row, and the resolver reports
 *      "never asked" (decision null, permitted false) — not a grant.
 *   3. CONSENT IS NECESSARY BUT NOT SUFFICIENT. canRecordInterview is false
 *      when recording_requested is false even with consent granted, and false
 *      when consent is absent even with recording_requested true.
 *   4. RE-GRANTING AFTER WITHDRAWAL WORKS — append-only, latest row wins.
 *   5. The internal revocation + toggle procedures are ROLE-GATED.
 *
 * Runs against the real kyndryl-poc tenant (it needs a signed confirm link,
 * which only scheduleInterview mints) in a dedicated n2a id namespace with
 * RUN-suffixed slugs, cleaned up either side. Requires `pnpm db:seed:test-users`.
 *
 * MIGRATION NOTE: the internal-revocation happy path needs migration 0117
 * (it widens the captured_via CHECK to allow 'internal_revocation'). 0117 is
 * authored but NOT applied, so test 7 reads pg_constraint and asserts the
 * behaviour that actually matches the live schema — it turns itself on the
 * moment 0117 lands rather than sitting silently red or silently absent.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { RECORDING_CONSENT_VERSION } from "../src/lib/interview-recording-consent";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const HR_HEAD = "hrhead1@mindssparc.com";

const N2A_BU = "00000000-0000-4000-8000-0000002a0001";
const N2A_POSITION = "00000000-0000-4000-8000-0000002a0002";
const N2A_JD = "00000000-0000-4000-8000-0000002a0003";
const N2A_REQ = "00000000-0000-4000-8000-0000002a0004";
const N2A_PERSON = "00000000-0000-4000-8000-0000002a0005";
const N2A_CANDIDATE = "00000000-0000-4000-8000-0000002a0006";
const N2A_APP = "00000000-0000-4000-8000-0000002a0007";

const RUN = Date.now().toString(36);

/** Provenance the consent log must capture off the candidate's request. */
const CANDIDATE_IP = "198.51.100.42";
const CANDIDATE_UA = "Mozilla/5.0 (n2a consent test)";
const CANDIDATE_HEADERS = {
  "content-type": "application/json",
  "x-forwarded-for": `${CANDIDATE_IP}, 10.0.0.1`,
  "user-agent": CANDIDATE_UA,
};

let recruiterJwt: string;
let hrHeadJwt: string;
let tenantId: string;
let recruiterMembershipId: string;

/** Round 1 — the long-lived fixture: consent granted → withdrawn → granted. */
let interviewA: string;
let tokenA: string;
/** Round 2 — confirmed with NO answer to the recording question. */
let interviewB: string;
let tokenB: string;

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
  error: { message?: string; data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
function data<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected tRPC error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
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

/** The wire shape of getInterviewRecordingState / the two mutations. */
interface RecordingStateView {
  interviewId: string;
  recordingRequested: boolean;
  consent: {
    decision: string | null;
    decidedAt: string | null;
    consentVersion: string | null;
    capturedVia: string | null;
    permitted: boolean;
  };
  canRecord: boolean;
}

async function readState(interviewId: string): Promise<RecordingStateView> {
  return data(
    await trpcQuery<RecordingStateView>(
      "getInterviewRecordingState",
      { interviewId },
      recruiterJwt,
    ),
  );
}

async function consentRows(interviewId: string) {
  return poolSql<
    {
      decision: string;
      captured_via: string;
      consent_version: string;
      ip_address: string | null;
      user_agent: string | null;
    }[]
  >`
    SELECT decision, captured_via, consent_version, ip_address, user_agent
    FROM public.interview_recording_consents
    WHERE tenant_id = ${tenantId} AND interview_id = ${interviewId}
    ORDER BY created_at ASC, id ASC
  `;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.interview_recording_consents WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ${N2A_APP})`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ${N2A_APP})`,
    () => poolSql`DELETE FROM public.interviews WHERE application_id = ${N2A_APP}`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${N2A_REQ}`,
    () =>
      poolSql`DELETE FROM public.notification_outbox WHERE recipient_candidate_id = ${N2A_CANDIDATE}`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${N2A_APP}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${N2A_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${N2A_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${N2A_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${N2A_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${N2A_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${N2A_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${N2A_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N2a cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${N2A_BU}, ${tenantId}, ${`N2A BU ${RUN}`}, ${`n2a-bu-${RUN}`})
  `;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${N2A_POSITION}, ${tenantId}, ${N2A_BU}, ${`N2A Platform Engineer ${RUN}`}, 'hybrid', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${N2A_JD}, ${tenantId}, ${N2A_POSITION}, 1, '# N2A JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${N2A_REQ}, ${tenantId}, ${N2A_POSITION}, ${N2A_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${N2A_PERSON}, ${tenantId}, 'Anitha Raghavan', ${`anitha.n2a-${RUN}@example.test`}, ${`anitha.n2a-${RUN}@example.test`})
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${N2A_CANDIDATE}, ${tenantId}, ${N2A_PERSON}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${N2A_APP}, ${tenantId}, ${N2A_CANDIDATE}, ${N2A_REQ}, 'career_site', 'recruiter_review', now())
  `;
}

function futureStart(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 19);
}

/** The confirm token lives only in the invitation's templateData. */
async function confirmTokenFor(interviewId: string): Promise<string> {
  const [row] = await poolSql<{ template_data: { confirmUrl?: string } }[]>`
    SELECT template_data FROM public.notification_outbox
    WHERE tenant_id = ${tenantId}
      AND template_key = 'candidate.interview_invitation'
      AND template_data->>'interviewId' = ${interviewId}
    ORDER BY created_at DESC LIMIT 1
  `;
  const url = row?.template_data?.confirmUrl;
  assert.ok(url, `confirmUrl missing from the invitation for ${interviewId}`);
  const token = url.split("/interviews/confirm/")[1];
  assert.ok(token, `could not parse token from ${url}`);
  return token;
}

async function scheduleRound(roundNumber: number, daysAhead: number): Promise<string> {
  const res = data(
    await trpcMutation<{ interviewId: string }>(
      "scheduleInterview",
      {
        applicationId: N2A_APP,
        roundNumber,
        scheduledStart: futureStart(daysAhead),
        panelMembershipIds: [recruiterMembershipId],
      },
      recruiterJwt,
    ),
  );
  return res.interviewId;
}

describe("N2a interview recording consent", () => {
  beforeAll(async () => {
    [recruiterJwt, hrHeadJwt] = await Promise.all([signIn(RECRUITER), signIn(HR_HEAD)]);
    const claims = decodeJwt(recruiterJwt);
    tenantId = (claims as { tid?: string }).tid as string;
    const userId = claims.sub as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${userId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!m) throw new Error("recruiter membership missing");
    recruiterMembershipId = m.id;

    await cleanup();
    await seedFixtures();

    data(
      await trpcMutation(
        "upsertInterviewPlan",
        {
          requisitionId: N2A_REQ,
          rounds: [1, 2].map((n) => ({
            roundNumber: n,
            roundName: n === 1 ? "Technical Screen" : "Hiring Manager",
            durationMinutes: 60,
            mode: "video",
            scorecardTemplate: "technical",
            competencyFocus: ["system_design"],
            defaultPanelMembershipIds: [recruiterMembershipId],
          })),
        },
        recruiterJwt,
      ),
    );

    interviewA = await scheduleRound(1, 3);
    tokenA = await confirmTokenFor(interviewA);
    interviewB = await scheduleRound(2, 5);
    tokenB = await confirmTokenFor(interviewB);
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. confirm + recordingConsent:true writes a 'granted' row AND still confirms", async () => {
    // Before anything is answered: never asked, and that must not read as
    // permission anywhere on the wire.
    const preview = await app.request(`/api/interviews/confirm/${tokenA}`, { method: "GET" });
    const previewBody = (await preview.json()) as {
      ok: boolean;
      recordingRequested: boolean;
      recordingConsent: { decision: string | null; permitted: boolean };
      recordingConsentDisclosure: { version: string; body: string[] };
    };
    assert.ok(previewBody.ok, `preview failed: ${JSON.stringify(previewBody)}`);
    assert.equal(previewBody.recordingConsent.decision, null, "no row yet = never asked");
    assert.equal(previewBody.recordingConsent.permitted, false, "absence is NOT permission");
    assert.equal(previewBody.recordingRequested, false, "recruiter intent defaults off");
    assert.equal(
      previewBody.recordingConsentDisclosure.version,
      RECORDING_CONSENT_VERSION,
      "copy is served with the version the POST will stamp",
    );
    assert.ok(previewBody.recordingConsentDisclosure.body.length > 0, "disclosure copy present");

    const confirm = await app.request(`/api/interviews/confirm/${tokenA}`, {
      method: "POST",
      headers: CANDIDATE_HEADERS,
      body: JSON.stringify({ recordingConsent: true }),
    });
    const confirmBody = (await confirm.json()) as {
      ok: boolean;
      confirmedAt: string | null;
      recordingConsent: { decision: string; permitted: boolean } | null;
    };
    assert.ok(confirmBody.ok, `confirm failed: ${JSON.stringify(confirmBody)}`);
    assert.ok(confirmBody.confirmedAt, "the confirmation is still the primary action");
    assert.equal(confirmBody.recordingConsent?.decision, "granted");
    assert.equal(confirmBody.recordingConsent?.permitted, true);

    const [row] = await poolSql<{ candidate_confirmed_at: string | null }[]>`
      SELECT candidate_confirmed_at FROM public.interviews WHERE id = ${interviewA}
    `;
    assert.ok(row?.candidate_confirmed_at, "candidate_confirmed_at not stamped");

    const rows = await consentRows(interviewA);
    assert.equal(rows.length, 1, "exactly one consent event from one candidate interaction");
    assert.equal(rows[0]!.decision, "granted");
    assert.equal(rows[0]!.captured_via, "candidate_confirm_link");
    assert.equal(rows[0]!.consent_version, RECORDING_CONSENT_VERSION);
    assert.equal(rows[0]!.ip_address, CANDIDATE_IP, "first x-forwarded-for hop is the provenance");
    assert.equal(rows[0]!.user_agent, CANDIDATE_UA);
  });

  it("2. confirm WITHOUT the field writes NO consent row (silence is not consent)", async () => {
    const confirm = await app.request(`/api/interviews/confirm/${tokenB}`, { method: "POST" });
    const confirmBody = (await confirm.json()) as {
      ok: boolean;
      recordingConsent: unknown;
    };
    assert.ok(confirmBody.ok, `confirm failed: ${JSON.stringify(confirmBody)}`);
    assert.equal(confirmBody.recordingConsent, null, "nothing was answered, nothing is reported");

    const rows = await consentRows(interviewB);
    assert.equal(rows.length, 0, "a candidate who wasn't asked has not consented");

    const state = await readState(interviewB);
    assert.equal(state.consent.decision, null, "never asked");
    assert.equal(state.consent.permitted, false);
  });

  it("3. WITHDRAWAL AFTER CONFIRMATION works — the whole reason the route is separate", async () => {
    // The confirm link is spent: this is exactly why consent cannot live on
    // that route alone.
    const reconfirm = await app.request(`/api/interviews/confirm/${tokenA}`, { method: "POST" });
    assert.equal(reconfirm.status, 409, "POST /confirm is single-use");
    assert.equal(
      ((await reconfirm.json()) as { reason?: string }).reason,
      "already_confirmed",
      "single-use is enforced by the signed_link_uses partial unique",
    );

    // The consent route is NOT single-use, and does not consume the link.
    const withdraw = await app.request(`/api/interviews/confirm/${tokenA}/recording-consent`, {
      method: "POST",
      headers: CANDIDATE_HEADERS,
      body: JSON.stringify({ decision: "withdrawn" }),
    });
    const withdrawBody = (await withdraw.json()) as {
      ok: boolean;
      recordingConsent: { decision: string; permitted: boolean };
    };
    assert.ok(withdrawBody.ok, `withdrawal failed: ${JSON.stringify(withdrawBody)}`);
    assert.equal(withdrawBody.recordingConsent.decision, "withdrawn");
    assert.equal(withdrawBody.recordingConsent.permitted, false, "the resolver must flip");

    const state = await readState(interviewA);
    assert.equal(state.consent.decision, "withdrawn");
    assert.equal(state.consent.permitted, false);
    assert.equal(state.canRecord, false, "not recordable once withdrawn");

    // Append-only: the grant is still there, it is simply no longer latest.
    const rows = await consentRows(interviewA);
    assert.equal(rows.length, 2, "a withdrawal is a NEW ROW, never an update");
    assert.deepEqual(
      rows.map((r) => r.decision),
      ["granted", "withdrawn"],
      "history is preserved in order",
    );

    // No signed_link_uses row is written for a consent change — that table
    // means "the confirm link was redeemed", and it stays true exactly once.
    const [uses] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.signed_link_uses
      WHERE tenant_id = ${tenantId} AND subject_id = ${interviewA} AND successful = true
    `;
    assert.equal(uses?.n, 1, "the consent route must not claim a second redemption");
  });

  it("4. re-granting after a withdrawal works (append, latest wins)", async () => {
    const regrant = await app.request(`/api/interviews/confirm/${tokenA}/recording-consent`, {
      method: "POST",
      headers: CANDIDATE_HEADERS,
      body: JSON.stringify({ decision: "granted" }),
    });
    const body = (await regrant.json()) as {
      ok: boolean;
      recordingConsent: { decision: string; permitted: boolean };
    };
    assert.ok(body.ok, `re-grant failed: ${JSON.stringify(body)}`);
    assert.equal(body.recordingConsent.decision, "granted");
    assert.equal(body.recordingConsent.permitted, true);

    const rows = await consentRows(interviewA);
    assert.deepEqual(
      rows.map((r) => r.decision),
      ["granted", "withdrawn", "granted"],
      "three events coexist; the latest is effective",
    );

    // Re-sending the same decision is harmless — it appends and resolves the
    // same. Nothing may add a unique that would "tidy" this away.
    const again = await app.request(`/api/interviews/confirm/${tokenA}/recording-consent`, {
      method: "POST",
      headers: CANDIDATE_HEADERS,
      body: JSON.stringify({ decision: "granted" }),
    });
    assert.equal(again.status, 200, "idempotent-friendly, not idempotency-enforced");
    assert.equal((await consentRows(interviewA)).length, 4);

    const bad = await app.request(`/api/interviews/confirm/${tokenA}/recording-consent`, {
      method: "POST",
      headers: CANDIDATE_HEADERS,
      body: JSON.stringify({ decision: "granted_i_guess" }),
    });
    assert.equal(bad.status, 400, "only granted / withdrawn are accepted here");
  });

  it("5. canRecordInterview needs BOTH consent and the recruiter's ask", async () => {
    // Consent is granted (test 4) but recording was never requested.
    const before = await readState(interviewA);
    assert.equal(before.consent.permitted, true, "consent is in place");
    assert.equal(before.recordingRequested, false);
    assert.equal(before.canRecord, false, "consent alone does NOT authorise recording");

    const on = data(
      await trpcMutation<RecordingStateView>(
        "setInterviewRecordingRequested",
        { interviewId: interviewA, requested: true },
        recruiterJwt,
      ),
    );
    assert.equal(on.recordingRequested, true);
    assert.equal(on.canRecord, true, "both facts present → recordable");

    const off = data(
      await trpcMutation<RecordingStateView>(
        "setInterviewRecordingRequested",
        { interviewId: interviewA, requested: false },
        recruiterJwt,
      ),
    );
    assert.equal(off.canRecord, false, "withdrawing the ask stops recording too");
    assert.equal(off.consent.permitted, true, "…without touching the candidate's consent");

    // The other direction: asked for, never consented to.
    const asked = data(
      await trpcMutation<RecordingStateView>(
        "setInterviewRecordingRequested",
        { interviewId: interviewB, requested: true },
        recruiterJwt,
      ),
    );
    assert.equal(asked.recordingRequested, true, "the toggle flips…");
    assert.equal(asked.consent.decision, null, "…but no one asked the candidate");
    assert.equal(asked.canRecord, false, "the toggle must not imply consent");
    assert.equal((await consentRows(interviewB)).length, 0, "the toggle writes no consent row");
  });

  it("6. the internal revocation + toggle procedures are role-gated", async () => {
    // hr_head holds no interview-manage role and is not hr_ops.
    const withdraw = await trpcMutation(
      "withdrawInterviewRecordingConsent",
      { interviewId: interviewA, reason: "Candidate emailed the DPO." },
      hrHeadJwt,
    );
    assert.ok(isErr(withdraw), "hr_head must not revoke recording consent");
    assert.equal(withdraw.error.data.code, "FORBIDDEN");

    const toggle = await trpcMutation(
      "setInterviewRecordingRequested",
      { interviewId: interviewA, requested: true },
      hrHeadJwt,
    );
    assert.ok(isErr(toggle), "hr_head must not flip the recording toggle");
    assert.equal(toggle.error.data.code, "FORBIDDEN");

    const read = await trpcQuery(
      "getInterviewRecordingState",
      { interviewId: interviewA },
      hrHeadJwt,
    );
    assert.ok(isErr(read), "hr_head must not read the consent state");
    assert.equal(read.error.data.code, "FORBIDDEN");
  });

  it("7. internal revocation appends a 'withdrawn' row (gated on migration 0117)", async () => {
    // 0117 widens the captured_via CHECK to allow 'internal_revocation'. It is
    // authored but not applied, so assert against whatever the live schema
    // actually is — this test turns itself on when 0117 lands.
    const [constraint] = await poolSql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'interview_recording_consents_captured_via_check'
      LIMIT 1
    `;
    assert.ok(constraint, "the captured_via CHECK must exist (migration 0116)");
    const applied0117 = constraint.def.includes("internal_revocation");

    const before = (await consentRows(interviewA)).length;
    const res = await trpcMutation<RecordingStateView>(
      "withdrawInterviewRecordingConsent",
      { interviewId: interviewA, reason: "Candidate phoned in a DPDPA withdrawal." },
      recruiterJwt,
    );

    if (!applied0117) {
      console.warn(
        "N2a test 7: migration 0117 is NOT applied — asserting the insert is REJECTED " +
          "rather than silently mis-attributed to the candidate.",
      );
      assert.ok(isErr(res), "without 0117 the CHECK must reject the internal capture seam");
      assert.equal(
        (await consentRows(interviewA)).length,
        before,
        "a rejected revocation must not append anything",
      );
      return;
    }

    const state = data(res);
    assert.equal(state.consent.decision, "withdrawn");
    assert.equal(state.consent.permitted, false);
    assert.equal(state.canRecord, false);

    const rows = await consentRows(interviewA);
    assert.equal(rows.length, before + 1, "a withdrawal is an append");
    assert.equal(
      rows[rows.length - 1]!.captured_via,
      "internal_revocation",
      "staff-actioned rows must never look like the candidate clicked",
    );
  });

  it("8. a cancelled round accepts no further consent changes", async () => {
    data(
      await trpcMutation(
        "cancelInterview",
        { interviewId: interviewB, reason: "N2a cleanup" },
        recruiterJwt,
      ),
    );
    const res = await app.request(`/api/interviews/confirm/${tokenB}/recording-consent`, {
      method: "POST",
      headers: CANDIDATE_HEADERS,
      body: JSON.stringify({ decision: "granted" }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { reason?: string }).reason, "already_cancelled");
    assert.equal((await consentRows(interviewB)).length, 0, "nothing was appended");
  });
});
