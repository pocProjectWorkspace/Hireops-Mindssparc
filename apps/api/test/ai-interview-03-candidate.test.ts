/**
 * N4.3a — the AI first round as the CANDIDATE experiences it: issuing the
 * link, the disclosure and consent, one question at a time, per-answer
 * capture, and the submit that hands the round to the transcript pipeline.
 *
 * WHAT EACH CASE PROTECTS
 *
 *   1. Issuing a link for a round whose mode is NOT 'ai_async' is refused.
 *      N4.2 left this open — questions can be generated for a `video` round —
 *      and issuing is where it closes, because issuing is the irreversible
 *      step: it is the moment a link exists that a person can answer into.
 *      Asserted with the refusal's side effects: no token, no status move,
 *      and `recording_requested` left alone.
 *   2. Issuing stores ONLY the SHA-256 of the token. The hash is recomputed
 *      here with node:crypto rather than with the platform's own hashToken,
 *      and the whole row is serialised and searched for the raw token, both
 *      halves of it included. A stored bearer credential for an unauthenticated
 *      interview surface is the thing this assertion exists to prevent.
 *   3. The GET does not consume the link, and it hands back EXACTLY ONE
 *      question with no `rubricKey` anywhere in the payload. Both halves are
 *      asserted on the raw response TEXT, not on the parsed object: a leak
 *      that survives JSON.parse is still a leak. A candidate who can read
 *      ahead is being interviewed under different conditions from one who
 *      cannot, and `rubricKey` is the marking scheme one level up from the
 *      "ideal answer" field the schema refuses to have.
 *   4. Declining consent REFUSES THE ROUND — honestly. The decline is written
 *      to the append-only consent log under this surface's own disclosure
 *      version and `captured_via`, the session does not start, no question is
 *      handed out, and a following answer is refused rather than quietly
 *      accepted as a text-only round the candidate never agreed to.
 *   5. A typed answer needs no upload and is stored AS TYPED. The mode
 *      assertion is the point: an evidence report built on typed text must
 *      never later be described as something the candidate said aloud. The
 *      all-typed round then submits with no recording and no outbox row.
 *   6. A wrong-content-type or oversized upload is refused — including an
 *      object that is over the cap in REALITY while the browser declared a
 *      legal size, which is the only version of the check that means anything.
 *   7. Submit inserts EXACTLY ONE `transcript_outbox` row. This is the AI
 *      round's producer for the pipeline N3.4a built the recruiter-upload
 *      producer for.
 *   8. A double submit absorbs 23505 and does not create a second row — both
 *      the concurrent shape (a caller holding a row it read while the session
 *      was still in progress, which is the only path that reaches the INSERT
 *      twice) and the ordinary double-tap through the route.
 *   9. An expired session refuses answers. Expiry is stamped LAZILY, on
 *      access — there is no sweep — so the case asserts that too: the status
 *      is still 'in_progress' after the deadline passes, and it is the
 *      refused request itself that moves it to 'expired'.
 *
 * LIB LEVEL vs THE HONO ROUTES. Cases 1, 2, 5, 6, 7 and 8 go through
 * ../src/lib/ai-interview-session directly: the thing under test is a
 * database effect (a hash, a stored answer mode, one outbox row) and the
 * route around it would only add an HTTP envelope to assert past. Cases 3, 4
 * and 9 go through the routes, because the HTTP shape IS the subject —
 * non-consumption of the link is a signed_link_uses fact only the route
 * writes, the wire payload is where a `rubricKey` leak would actually land,
 * and the decline / expiry refusals are candidate-facing status codes (403,
 * 409) rather than exceptions. Case 8 uses both for the same reason: the
 * concurrent double submit is unreachable through a route (every route
 * reloads the row first), and the double-tap is only reachable through one.
 *
 * Runs entirely inside its own synthetic tenant (43a namespace, RUN-suffixed
 * slugs/emails) via poolSql, so it touches no demo data and needs no JWT.
 * NODE_ENV=test forces LocalStorageClient, so the browser's direct PUT is
 * stood in for by writeLocalSignedUploadUrl() — no network, no Supabase.
 * REQUIRES migrations 0116–0119.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { verifyLink } from "@hireops/notifications";
import { app } from "../src/index.js";
import { resetStorageClient, writeLocalSignedUploadUrl } from "../src/lib/storage";
import {
  AI_INTERVIEW_DISCLOSURE,
  AI_INTERVIEW_LINK_ACTION,
  CONSENT_VIA_AI_INTERVIEW_LINK,
  createAnswerUploadUrl,
  expireIfLapsed,
  issueSession,
  loadSessionByTokenHash,
  recordAnswer,
  startSession,
  submitSession,
  type AiInterviewSessionRow,
  type CandidateRefusalResult,
  type CandidateResult,
} from "../src/lib/ai-interview-session";

// Fixed synthetic ids (43a namespace — hex only; raw SQL, no Zod in the way).
const T = "00000000-0000-4000-8000-00000043a001";
const BU = "00000000-0000-4000-8000-00000043a002";
const POSITION = "00000000-0000-4000-8000-00000043a003";
const JD = "00000000-0000-4000-8000-00000043a004";
const REQ = "00000000-0000-4000-8000-00000043a005";
const PERSON = "00000000-0000-4000-8000-00000043a006";
const CANDIDATE = "00000000-0000-4000-8000-00000043a007";
const APP = "00000000-0000-4000-8000-00000043a008";
const MEMBERSHIP = "00000000-0000-4000-8000-00000043a009";

/** One interview per case — 0119 allows exactly one session per interview. */
const IV_VIDEO = "00000000-0000-4000-8000-00000043a010";
const IV_MAIN = "00000000-0000-4000-8000-00000043a011";
const IV_DECLINE = "00000000-0000-4000-8000-00000043a012";
const IV_TYPED = "00000000-0000-4000-8000-00000043a013";
const IV_LIMITS = "00000000-0000-4000-8000-00000043a014";
const IV_VOICE = "00000000-0000-4000-8000-00000043a015";
const IV_EXPIRED = "00000000-0000-4000-8000-00000043a016";

const RUN = Date.now().toString(36);
const TENANT_SLUG = `synth-n43a-${RUN}`;
const PORTAL = "https://portal.n43a.test";

/** The frozen set. Q2/Q3 exist so "exactly one question" has something to
 * fail against — case 3 asserts their text never reaches the candidate. */
const Q1 = "Walk me through an escalation you owned end to end. What did you do first?";
const Q2 = "Describe a problem where the obvious fix was wrong. How did you find the real one?";
const Q3 = "Tell me about explaining an outage to a frustrated customer. What did you say?";
const QUESTIONS = [
  { key: "q1", prompt: Q1, rubricKey: "role_competence" },
  { key: "q2", prompt: Q2, rubricKey: "problem_solving" },
  { key: "q3", prompt: Q3, rubricKey: "communication" },
];
/** The round's frozen rubric — what `questions[].rubricKey` points into. */
const RUBRIC = [
  { key: "role_competence", label: "Role competence" },
  { key: "problem_solving", label: "Problem solving" },
  { key: "communication", label: "Communication" },
];

/** Real bytes, so the voice path has a real object size to read back. */
const MEDIA = Buffer.from(
  `n43a synthetic round audio ${RUN} — long enough to have a size worth asserting on`,
);
const MEDIA_TYPE = "audio/webm";
/** What a browser actually sends: MediaRecorder attaches codec parameters. */
const DECLARED_TYPE = "audio/webm;codecs=opus";

/** A real auth.users id — tenant_user_memberships.user_id FKs to it at the SQL
 * level. Borrowing an existing membership's user_id needs no sign-in. */
let userId: string;

/** Carried between cases. */
let mainToken: string;
let declineToken: string;
let voiceToken: string;
let voiceRecordingId: string;
/** The in-progress row case 8 re-submits — the loser of the submit race. */
let staleVoiceRow: AiInterviewSessionRow;

interface StoredAnswer {
  questionKey: string;
  mode: string;
  answeredAt: string;
  startMs: number | null;
  endMs: number | null;
  text: string | null;
}
interface StoredTurnState {
  answers?: StoredAnswer[];
  mediaSizeBytes?: number | null;
  mediaContentType?: string | null;
}

/**
 * The token hash, computed HERE rather than by importing the platform's
 * hashToken: an assertion that a column holds `hashToken(token)` is satisfied
 * by any hashToken, including one that returned the token unchanged.
 */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The candidate URL is `${portal}/interviews/ai/${token}`; base64url has no
 * slash, so the last segment is the whole token. */
function tokenFromUrl(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

async function issue(interviewId: string): Promise<string> {
  const result = await issueSession(poolSql, {
    tenantId: T,
    interviewId,
    portalBaseUrl: PORTAL,
  });
  return tokenFromUrl(result.interviewUrl);
}

async function sessionByToken(token: string): Promise<AiInterviewSessionRow> {
  const row = await loadSessionByTokenHash(poolSql, sha256(token));
  if (!row) assert.fail("the session must be findable by its token hash");
  return row;
}

/** Unwrap a CandidateResult, failing with the refusal the surface gave. */
function value<T>(result: CandidateResult<T>, what: string): T {
  if (!result.ok) assert.fail(`${what} was refused: ${result.refusal} — ${result.message}`);
  return result.value;
}

/** The mirror image: assert a refusal and hand back its reason. */
function refusalOf(result: CandidateResult<unknown>, what: string): CandidateRefusalResult {
  if (result.ok) assert.fail(`${what} should have been refused`);
  return result;
}

async function expectThrows(fn: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail(`${what} should have thrown`);
}

interface CandidateResponse {
  status: number;
  /** The RAW body — case 3 searches it for what must not be on the wire. */
  text: string;
  body: Record<string, unknown>;
}

async function candidateGet(token: string): Promise<CandidateResponse> {
  const res = await app.request(`/api/interviews/ai/${token}`);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function candidatePost(
  token: string,
  path: string,
  body: unknown,
): Promise<CandidateResponse> {
  const res = await app.request(`/api/interviews/ai/${token}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function sessionRow(interviewId: string): Promise<{
  id: string;
  status: string;
  started_at: Date | string | null;
  submitted_at: Date | string | null;
  link_token_hash: string | null;
  expires_at: Date | string | null;
}> {
  const [row] = await poolSql<
    {
      id: string;
      status: string;
      started_at: Date | string | null;
      submitted_at: Date | string | null;
      link_token_hash: string | null;
      expires_at: Date | string | null;
    }[]
  >`
    SELECT id, status, started_at, submitted_at, link_token_hash, expires_at
    FROM public.ai_interview_sessions
    WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
  if (!row) assert.fail(`no ai_interview_sessions row for ${interviewId}`);
  return row;
}

async function turnStateOf(interviewId: string): Promise<StoredTurnState> {
  const [row] = await poolSql<{ turn_state: StoredTurnState }[]>`
    SELECT turn_state FROM public.ai_interview_sessions
    WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
  if (!row) assert.fail(`no ai_interview_sessions row for ${interviewId}`);
  return row.turn_state;
}

interface RecordingRow {
  id: string;
  status: string;
  source: string;
  media_type: string | null;
  size_bytes: string | number | null;
  duration_seconds: string | number | null;
}

async function recordingsFor(interviewId: string): Promise<RecordingRow[]> {
  return poolSql<RecordingRow[]>`
    SELECT id, status, source, media_type, size_bytes, duration_seconds
    FROM public.interview_recordings
    WHERE tenant_id = ${T} AND interview_id = ${interviewId}
  `;
}

async function outboxRows(recordingId: string): Promise<{ id: string; status: string }[]> {
  return poolSql<{ id: string; status: string }[]>`
    SELECT id, status FROM public.transcript_outbox
    WHERE tenant_id = ${T} AND recording_id = ${recordingId}
  `;
}

async function linkUses(token: string): Promise<{ successful: boolean; reason: string | null }[]> {
  return poolSql<{ successful: boolean; reason: string | null }[]>`
    SELECT successful, failure_reason AS reason FROM public.signed_link_uses
    WHERE tenant_id = ${T} AND token_hash = ${sha256(token)}
  `;
}

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.transcript_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_notes WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_transcripts WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_interview_sessions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recording_consents WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`,
    // LAST, because the deletes above fire the audit triggers on
    // ai_interview_sessions, interview_recordings and interviews — a sweep
    // that ran first would leave exactly those rows behind. Tenant-wide is
    // safe here and only here: T is synthetic and holds nothing else.
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N4.3a cleanup step failed (continuing):", err);
    }
  }
}

async function seedInterview(id: string, round: number, mode: string): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scorecard_criteria_snapshot, duration_minutes, mode,
       created_by_membership_id, recording_requested)
    VALUES (${id}, ${T}, ${APP}, ${REQ}, ${round}, ${`N43A Round ${round}`}, 'scheduled',
            'general', ${JSON.stringify(RUBRIC)}::jsonb, 30, ${mode}, ${MEMBERSHIP}, false)
  `;
}

/**
 * A session in exactly the state N4.2 leaves behind: approved by a named
 * human, questions frozen, no link. Hand-inserted rather than generated —
 * the generation call is N4.2's subject and would cost a fixture here.
 */
async function seedApprovedSession(interviewId: string): Promise<void> {
  await poolSql`
    INSERT INTO public.ai_interview_sessions
      (tenant_id, interview_id, status, questions, approved_by_membership_id, approved_at,
       questions_frozen_at, model, prompt_version)
    VALUES (${T}, ${interviewId}, 'approved', ${JSON.stringify(QUESTIONS)}::jsonb,
            ${MEMBERSHIP}, now(), now(), 'local-test', 'n42-v1')
  `;
}

describe("N4.3a — the AI interview candidate surface", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    if (!existing) assert.fail("no tenant_user_memberships row to borrow a user_id from");
    userId = existing.user_id;

    await cleanup();
    resetStorageClient();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, ${TENANT_SLUG}, ${`AI Interview Synth ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N43A BU ${RUN}`}, ${`n43a-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N43A Support Engineer ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1,
              '# N43A JD — support engineer. Owns customer escalations.', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N43A Candidate',
              ${`n43a-cand-${RUN}@example.test`}, ${`n43a-cand-${RUN}@example.test`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CANDIDATE}, ${T}, ${PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APP}, ${T}, ${CANDIDATE}, ${REQ}, 'career_site', 'tech_interview', now())
    `;

    // IV_VIDEO is deliberately a human round with an APPROVED question set:
    // everything about it is ready except the one thing case 1 is about.
    const rounds = [
      [IV_VIDEO, 1, "video"],
      [IV_MAIN, 2, "ai_async"],
      [IV_DECLINE, 3, "ai_async"],
      [IV_TYPED, 4, "ai_async"],
      [IV_LIMITS, 5, "ai_async"],
      [IV_VOICE, 6, "ai_async"],
      [IV_EXPIRED, 7, "ai_async"],
    ] as const;
    for (const [id, round, mode] of rounds) {
      await seedInterview(id, round, mode);
      await seedApprovedSession(id);
    }
  });

  afterAll(async () => {
    await cleanup();
    resetStorageClient();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: a round that is not 'ai_async' cannot be issued to a candidate", async () => {
    const err = await expectThrows(() => issue(IV_VIDEO), "issuing a link for a video round");
    if (!(err instanceof TRPCError)) assert.fail(`expected a TRPCError, got: ${String(err)}`);
    assert.equal(err.code, "BAD_REQUEST");
    // The refusal names BOTH modes: a recruiter has to be able to tell what
    // this round is from what it would have to be.
    assert.match(err.message, /'video'/);
    assert.match(err.message, /'ai_async'/);

    // Nothing moved. In particular no token was minted and then discarded —
    // the guard runs before the link exists at all.
    const session = await sessionRow(IV_VIDEO);
    assert.equal(session.status, "approved");
    assert.equal(session.link_token_hash, null);
    assert.equal(session.expires_at, null);

    const [iv] = await poolSql<{ recording_requested: boolean }[]>`
      SELECT recording_requested FROM public.interviews
      WHERE tenant_id = ${T} AND id = ${IV_VIDEO}
    `;
    if (!iv) assert.fail("the video round vanished");
    assert.equal(
      iv.recording_requested,
      false,
      "a refused issue must not flip the recruiter's recording ask",
    );
  });

  it("Test 2: issuing stores ONLY the token hash — the raw token is never persisted", async () => {
    const result = await issueSession(poolSql, {
      tenantId: T,
      interviewId: IV_MAIN,
      portalBaseUrl: PORTAL,
    });
    mainToken = tokenFromUrl(result.interviewUrl);
    assert.equal(result.interviewUrl, `${PORTAL}/interviews/ai/${mainToken}`);
    assert.equal(result.session.status, "issued");

    // The returned token is a REAL link for THIS session, not a placeholder:
    // it verifies, it carries this surface's action (so a confirm token can
    // never be replayed here) and its subject is the session row.
    const verified = verifyLink(mainToken);
    if (!verified.ok) assert.fail(`the issued token must verify: ${verified.reason}`);
    assert.equal(verified.payload.action, AI_INTERVIEW_LINK_ACTION);
    assert.equal(verified.payload.subjectId, result.session.sessionId);

    const [stored] = await poolSql<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(s) AS row FROM public.ai_interview_sessions s
      WHERE s.tenant_id = ${T} AND s.interview_id = ${IV_MAIN}
    `;
    if (!stored) assert.fail("no session row after issuing");
    const row = stored.row;

    assert.equal(row.status, "issued");
    assert.equal(
      row.link_token_hash,
      sha256(mainToken),
      "link_token_hash must be the SHA-256 of the token that was handed out",
    );

    // THE POINT: the raw token is a bearer credential for an unauthenticated
    // interview. The WHOLE row is searched, not just the column we expect it
    // in — a leak into `turn_state` or a stray column would be just as bad.
    const serialised = JSON.stringify(row);
    const [payloadPart, macPart] = mainToken.split(".");
    if (!payloadPart || !macPart) assert.fail("a signed link is <payload>.<mac>");
    assert.ok(!serialised.includes(mainToken), "the raw token must appear nowhere in the row");
    assert.ok(!serialised.includes(macPart), "not even the MAC half of it");
    assert.ok(!serialised.includes(payloadPart), "nor the payload half");

    // The link and the session share ONE expiry instant, so verifyLink's own
    // expiry and the session's cannot drift into disagreeing.
    assert.equal(iso(row.expires_at as string), result.expiresAt);
    assert.equal(
      verified.payload.expiresAt.getTime(),
      // The token carries epoch SECONDS; the session keeps milliseconds.
      Math.floor(new Date(result.expiresAt).getTime() / 1000) * 1000,
    );
    const days = (new Date(result.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7.01, `default window is a week, got ${days} days`);

    // Issuing IS the request to record for an AI round — there is no separate
    // recruiter moment later, and canRecordInterview needs both halves.
    const [iv] = await poolSql<{ recording_requested: boolean }[]>`
      SELECT recording_requested FROM public.interviews
      WHERE tenant_id = ${T} AND id = ${IV_MAIN}
    `;
    if (!iv) assert.fail("the round vanished");
    assert.equal(iv.recording_requested, true);
  });

  it("Test 3: the GET does not consume the link and serves ONE question, never a rubricKey", async () => {
    assert.equal((await linkUses(mainToken)).length, 0, "precondition: the link is unused");

    // Before consent the candidate is looking at the disclosure and has
    // agreed to nothing, so no question is handed out at all.
    const before = await candidateGet(mainToken);
    assert.equal(before.status, 200);
    assert.equal(before.body.ok, true);
    assert.equal(before.body.status, "issued");
    assert.equal(before.body.currentQuestion, null, "no question before the round starts");
    assert.equal(before.body.questionCount, 3);
    assert.equal(before.body.answeredCount, 0);
    assert.equal(before.body.roundAudio, "cumulative");
    for (const secret of [Q1, Q2, Q3, "rubricKey"]) {
      assert.ok(!before.text.includes(secret), `the pre-consent read leaked: ${secret}`);
    }

    const started = await candidatePost(mainToken, "/start", { consent: true });
    assert.equal(started.status, 200);
    assert.equal(started.body.status, "in_progress");
    assert.ok(!started.text.includes("rubricKey"), "the start response leaked a rubricKey");

    const after = await candidateGet(mainToken);
    assert.equal(after.status, 200);
    const current = after.body.currentQuestion as Record<string, unknown> | null;
    if (!current) assert.fail("a started round must hand back the question the candidate is on");

    // TWO FIELDS PLUS THE POSITION, and nothing else. Asserted as the exact
    // key set so a later widening of the stored shape fails here rather than
    // shipping the marking scheme to the candidate.
    assert.deepEqual(Object.keys(current).sort(), ["index", "key", "of", "prompt"]);
    assert.equal(current.key, "q1");
    assert.equal(current.prompt, Q1);
    assert.equal(current.index, 1);
    assert.equal(current.of, 3);

    // THE ANTI-READ-AHEAD GUARANTEE, on the raw wire bytes: the questions
    // after this one never leave the server, and neither does the internal
    // scoring vocabulary.
    assert.ok(!after.text.includes(Q2), "question 2 was readable ahead of time");
    assert.ok(!after.text.includes(Q3), "question 3 was readable ahead of time");
    assert.ok(!after.text.includes("rubricKey"), "the candidate was handed the marking scheme");
    for (const key of RUBRIC) {
      assert.ok(!after.text.includes(key.key), `rubric key '${key.key}' reached the candidate`);
    }

    // AND THE LINK IS STILL UNSPENT — non-consumption is what makes resuming
    // a round on a dead browser possible at all.
    assert.equal(
      (await linkUses(mainToken)).length,
      0,
      "neither the read nor the start may consume the link",
    );
  });

  it("Test 4: declining consent refuses the round — no start, no question, no fallback", async () => {
    declineToken = await issue(IV_DECLINE);

    const declined = await candidatePost(declineToken, "/start", { consent: false });
    assert.equal(declined.status, 403);
    assert.equal(declined.body.reason, "consent_required");
    const message = String(declined.body.message ?? "");
    // The copy is the refusal: this round IS the recording, so there is no
    // version of it that runs without one.
    assert.match(message, /nothing has been kept/i);
    assert.match(message, /no version of this round that can run without recording/i);

    // The decision is on the record — append-only, under THIS surface's
    // disclosure version and captured_via, not the confirm page's.
    const consents = await poolSql<
      { decision: string; captured_via: string; consent_version: string }[]
    >`
      SELECT decision, captured_via, consent_version
      FROM public.interview_recording_consents
      WHERE tenant_id = ${T} AND interview_id = ${IV_DECLINE}
    `;
    assert.equal(consents.length, 1, "a decline is still a fact worth logging");
    assert.equal(consents[0]?.decision, "declined");
    assert.equal(consents[0]?.captured_via, CONSENT_VIA_AI_INTERVIEW_LINK);
    assert.equal(consents[0]?.consent_version, AI_INTERVIEW_DISCLOSURE.version);

    // The round did not start.
    const session = await sessionRow(IV_DECLINE);
    assert.equal(session.status, "issued");
    assert.equal(session.started_at, null);

    // AND THERE IS NO QUIET TEXT-ONLY FALLBACK. An answer offered anyway is
    // refused; running an unrecorded variant of a round the candidate
    // declined would be agreeing to something on their behalf.
    const refused = refusalOf(
      await recordAnswer(poolSql, await sessionByToken(declineToken), {
        questionKey: "q1",
        mode: "typed",
        text: "I would still like to answer in writing.",
      }),
      "answering a round whose recording consent was declined",
    );
    assert.ok(
      refused.refusal === "not_started" || refused.refusal === "consent_required",
      `expected the round to be closed, got '${refused.refusal}'`,
    );

    const state = await turnStateOf(IV_DECLINE);
    assert.equal((state.answers ?? []).length, 0, "nothing was captured");
    assert.equal((await recordingsFor(IV_DECLINE)).length, 0, "nothing was recorded");

    // The candidate can still read the round and see where they stand — and
    // still is not shown a question.
    const view = await candidateGet(declineToken);
    assert.equal(view.status, 200);
    assert.equal(view.body.currentQuestion, null);
    const consent = view.body.recordingConsent as Record<string, unknown>;
    assert.equal(consent.decision, "declined");
    assert.equal(consent.permitted, false);
  });

  it("Test 5: a typed answer needs no upload and is stored AS TYPED", async () => {
    const token = await issue(IV_TYPED);
    const started = value(
      await startSession(poolSql, await sessionByToken(token), {
        consentGranted: true,
        ipAddress: "203.0.113.7",
        userAgent: "vitest/n43a",
      }),
      "starting the typed round",
    );
    assert.equal(started.view.status, "in_progress");
    assert.equal(started.view.currentQuestion?.key, "q1");

    const recorded = value(
      await recordAnswer(poolSql, await sessionByToken(token), {
        questionKey: "q1",
        mode: "typed",
        text: "  I owned the incident bridge from the first page to the write-up.  ",
      }),
      "recording a typed answer",
    );

    // THE ASSERTION THIS CASE EXISTS FOR. Voice and typed are different
    // evidence about different things, and an evidence report built on typed
    // text must never be described as something the candidate said aloud.
    assert.equal(recorded.answer.mode, "typed");
    assert.equal(
      recorded.answer.text,
      "I owned the incident bridge from the first page to the write-up.",
    );
    assert.equal(
      recorded.answer.startMs,
      null,
      "typed answers have no place on the audio timeline",
    );
    assert.equal(recorded.answer.endMs, null);
    assert.equal(recorded.view.answeredCount, 1);
    assert.equal(recorded.view.currentQuestion?.key, "q2", "the turn advanced");

    // …and that mode is what is on the row, not just in the response.
    const state = await turnStateOf(IV_TYPED);
    assert.equal((state.answers ?? []).length, 1);
    assert.equal(state.answers?.[0]?.questionKey, "q1");
    assert.equal(state.answers?.[0]?.mode, "typed");
    assert.equal(state.mediaSizeBytes ?? null, null);
    assert.equal(state.mediaContentType ?? null, null);

    // NO UPLOAD HAPPENED. A typed answer is not a voice answer with an empty
    // media leg — it never touches storage and creates no recording row.
    assert.equal((await recordingsFor(IV_TYPED)).length, 0, "a typed answer touches no storage");

    // An all-typed round therefore enqueues nothing: there is no audio, so
    // there is nothing to transcribe, and a recording row would be asserting
    // media that does not exist.
    const submitted = value(
      await submitSession(poolSql, await sessionByToken(token), {}),
      "submitting an all-typed round",
    );
    assert.equal(submitted.recordingId, null);
    assert.equal(submitted.enqueued, false);
    assert.equal(submitted.answeredCount, 1);
    assert.equal(submitted.questionCount, 3);
    assert.equal(submitted.view.status, "submitted");
    const [{ n } = { n: "0" }] = await poolSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM public.transcript_outbox WHERE tenant_id = ${T}
    `;
    assert.equal(n, "0", "no voice round has been submitted yet, so the queue is still empty");
  });

  it("Test 6: a wrong content type and an oversized object are both refused", async () => {
    const token = await issue(IV_LIMITS);
    value(
      await startSession(poolSql, await sessionByToken(token), {
        consentGranted: true,
        ipAddress: null,
        userAgent: "vitest/n43a",
      }),
      "starting the limits round",
    );

    const wrongType = refusalOf(
      await createAnswerUploadUrl(poolSql, await sessionByToken(token), {
        questionKey: "q1",
        contentType: "video/mp4",
        sizeBytes: MEDIA.byteLength,
      }),
      "an upload declaring video/mp4",
    );
    assert.equal(wrongType.refusal, "invalid_content_type");
    assert.match(wrongType.message, /video\/mp4/);

    const tooBig = refusalOf(
      await createAnswerUploadUrl(poolSql, await sessionByToken(token), {
        questionKey: "q1",
        contentType: DECLARED_TYPE,
        // 400MB — above the 250MB media ceiling, well below anything a
        // browser would produce from a first-round answer by accident.
        sizeBytes: 400 * 1024 * 1024,
      }),
      "an upload declaring 400MB",
    );
    assert.equal(tooBig.refusal, "too_large");
    assert.match(tooBig.message, /the limit is \d+/);

    assert.equal(
      (await recordingsFor(IV_LIMITS)).length,
      0,
      "a refused upload must not leave a recording row behind",
    );

    // AND THE DECLARATION IS NOT TRUSTED. The browser can say anything; the
    // size that counts is the one on the object, measured at completion.
    const minted = value(
      await createAnswerUploadUrl(poolSql, await sessionByToken(token), {
        questionKey: "q1",
        contentType: DECLARED_TYPE,
        sizeBytes: MEDIA.byteLength,
      }),
      "minting the checkpoint url",
    );
    writeLocalSignedUploadUrl(minted.uploadUrl, MEDIA, { contentType: MEDIA_TYPE });

    const previousCap = process.env.MEDIA_MAX_UPLOAD_BYTES;
    process.env.MEDIA_MAX_UPLOAD_BYTES = String(MEDIA.byteLength - 1);
    try {
      const oversized = refusalOf(
        await recordAnswer(poolSql, await sessionByToken(token), {
          questionKey: "q1",
          mode: "voice",
          startMs: 0,
          endMs: 1_000,
        }),
        "an answer whose object is over the cap",
      );
      assert.equal(oversized.refusal, "too_large");
      assert.match(oversized.message, /the limit is \d+/);
    } finally {
      if (previousCap === undefined) delete process.env.MEDIA_MAX_UPLOAD_BYTES;
      else process.env.MEDIA_MAX_UPLOAD_BYTES = previousCap;
    }

    const state = await turnStateOf(IV_LIMITS);
    assert.equal((state.answers ?? []).length, 0, "a refused answer does not advance the turn");
  });

  it("Test 7: submit inserts EXACTLY ONE transcript_outbox row", async () => {
    voiceToken = await issue(IV_VOICE);
    value(
      await startSession(poolSql, await sessionByToken(voiceToken), {
        consentGranted: true,
        ipAddress: null,
        userAgent: "vitest/n43a",
      }),
      "starting the voice round",
    );

    const minted = value(
      await createAnswerUploadUrl(poolSql, await sessionByToken(voiceToken), {
        questionKey: "q1",
        // Codec parameters attached, exactly as MediaRecorder reports them.
        contentType: DECLARED_TYPE,
        sizeBytes: MEDIA.byteLength,
      }),
      "minting the round's upload url",
    );
    assert.equal(minted.method, "PUT");
    assert.equal(minted.provider, "local", "NODE_ENV=test must select the local tier");
    assert.equal(minted.contentType, MEDIA_TYPE, "the stored type is the normalised one");
    assert.equal(minted.roundAudio, "cumulative", "the media contract is restated on the wire");
    // ONE object per ROUND — the key is the interview's, not the answer's.
    assert.equal(minted.storageKey, `interview-media/${T}/${IV_VOICE}.webm`);

    // Stand in for the browser's direct PUT.
    writeLocalSignedUploadUrl(minted.uploadUrl, MEDIA, { contentType: MEDIA_TYPE });

    const recorded = value(
      await recordAnswer(poolSql, await sessionByToken(voiceToken), {
        questionKey: "q1",
        mode: "voice",
        startMs: 0,
        endMs: 42_000,
      }),
      "recording a voice answer",
    );
    assert.equal(recorded.answer.mode, "voice");
    assert.equal(recorded.answer.startMs, 0);
    assert.equal(recorded.answer.endMs, 42_000);
    assert.equal(recorded.answer.text, null);

    const state = await turnStateOf(IV_VOICE);
    assert.equal(
      state.mediaSizeBytes,
      MEDIA.byteLength,
      "the accepted checkpoint's real size is what the next one is measured against",
    );
    assert.equal(state.mediaContentType, MEDIA_TYPE);

    // Kept for case 8: a caller that read the row while the round was still
    // running is the only way to reach the INSERT twice.
    staleVoiceRow = await sessionByToken(voiceToken);

    const submitted = value(
      await submitSession(poolSql, staleVoiceRow, { durationSeconds: 42 }),
      "submitting the voice round",
    );
    assert.equal(submitted.enqueued, true);
    assert.equal(submitted.view.status, "submitted");
    assert.equal(submitted.answeredCount, 1);
    if (!submitted.recordingId) assert.fail("a voice round must produce a recording");
    voiceRecordingId = submitted.recordingId;

    const rows = await outboxRows(voiceRecordingId);
    assert.equal(rows.length, 1, "EXACTLY ONE transcript_outbox row — the AI round's producer");
    assert.equal(rows[0]?.status, "pending");

    const recordings = await recordingsFor(IV_VOICE);
    assert.equal(recordings.length, 1, "ONE AI round is ONE recording (0119)");
    const rec = recordings[0];
    if (!rec) assert.fail("no recording row");
    assert.equal(rec.id, voiceRecordingId);
    assert.equal(rec.status, "uploaded");
    assert.equal(rec.source, "ai_interview");
    assert.equal(rec.media_type, MEDIA_TYPE);
    assert.equal(Number(rec.size_bytes), MEDIA.byteLength);
    assert.equal(Number(rec.duration_seconds), 42);
  });

  it("Test 8: a double submit absorbs 23505 and does not create a second row", async () => {
    const before = await sessionRow(IV_VOICE);
    assert.equal(before.status, "submitted");

    // THE RACE, as the implementation describes it: the loser still reaches
    // the INSERT, because a crash between the status move and the enqueue
    // would otherwise leave a submitted round nothing ever transcribes.
    const again = value(
      await submitSession(poolSql, staleVoiceRow, {}),
      "a concurrent second submit",
    );
    assert.equal(again.enqueued, false, "already queued — success, not an error");
    assert.equal(
      (await outboxRows(voiceRecordingId)).length,
      1,
      "UNIQUE (tenant_id, recording_id) held and the 23505 was absorbed",
    );

    // And the ordinary double-tap, through the route, is refused outright.
    const http = await candidatePost(voiceToken, "/submit", {});
    assert.equal(http.status, 409);
    assert.equal(http.body.reason, "already_submitted");
    assert.equal((await outboxRows(voiceRecordingId)).length, 1);

    const after = await sessionRow(IV_VOICE);
    assert.equal(
      iso(after.submitted_at),
      iso(before.submitted_at),
      "submitted_at is not re-stamped by a second submit",
    );
  });

  it("Test 9: an expired session refuses answers, and the refusal is what stamps it", async () => {
    const token = await issue(IV_EXPIRED);
    value(
      await startSession(poolSql, await sessionByToken(token), {
        consentGranted: true,
        ipAddress: null,
        userAgent: "vitest/n43a",
      }),
      "starting the round that will lapse",
    );

    await poolSql`
      UPDATE public.ai_interview_sessions
      SET expires_at = now() - interval '1 hour'
      WHERE tenant_id = ${T} AND interview_id = ${IV_EXPIRED}
    `;

    // NO SWEEP. The status is still 'in_progress' after the deadline has
    // passed — "in progress, never finished" — and it stays that way until
    // somebody touches the link.
    const lapsed = await sessionRow(IV_EXPIRED);
    assert.equal(lapsed.status, "in_progress", "expiry is stamped lazily, on access");

    const answer = await candidatePost(token, "/answer", {
      questionKey: "q1",
      mode: "typed",
      text: "Sorry I am late — can I still answer?",
    });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.reason, "expired");
    assert.match(String(answer.body.message ?? ""), /expired/i);

    const stamped = await sessionRow(IV_EXPIRED);
    assert.equal(
      stamped.status,
      "expired",
      "the request that refused the answer is the one that stamped the lapse",
    );

    // The same refusal at the lib level, on a row loaded after the fact —
    // including expireIfLapsed being idempotent once the status has moved.
    const row = await sessionByToken(token);
    assert.equal(row.status, "expired");
    const rechecked = await expireIfLapsed(poolSql, row);
    assert.equal(rechecked.status, "expired");

    const refusedAnswer = refusalOf(
      await recordAnswer(poolSql, rechecked, {
        questionKey: "q1",
        mode: "typed",
        text: "Trying again.",
      }),
      "answering an expired round",
    );
    assert.equal(refusedAnswer.refusal, "expired");

    const refusedSubmit = refusalOf(
      await submitSession(poolSql, rechecked, {}),
      "submitting an expired round",
    );
    assert.equal(refusedSubmit.refusal, "expired");

    const state = await turnStateOf(IV_EXPIRED);
    assert.equal((state.answers ?? []).length, 0, "nothing was captured after the deadline");
    assert.equal((await recordingsFor(IV_EXPIRED)).length, 0);

    // The READ stays open, deliberately: a candidate who arrives late has to
    // be able to see WHY they cannot continue.
    const view = await candidateGet(token);
    assert.equal(view.status, 200);
    assert.equal(view.body.status, "expired");
    assert.equal(view.body.currentQuestion, null);
  });
});
