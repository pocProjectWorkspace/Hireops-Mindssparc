import { Hono, type Context } from "hono";
import { sql as poolSql } from "@hireops/db";
import { verifyLink } from "@hireops/notifications";
import { baseLog } from "../lib/observability";
import {
  CONSENT_VIA_CANDIDATE_LINK,
  RECORDING_CONSENT_DISCLOSURE,
  recordRecordingConsent,
  resolveRecordingConsent,
  type EffectiveRecordingConsent,
  type RecordingConsentDecision,
} from "../lib/interview-recording-consent";
import {
  AI_INTERVIEW_LINK_ACTION,
  createAnswerUploadUrl,
  expireIfLapsed,
  loadSessionByTokenHash,
  recordAnswer,
  startSession,
  submitSession,
  toCandidateView,
  type AiInterviewSessionRow,
  type CandidateRefusal,
  type CandidateRefusalResult,
} from "../lib/ai-interview-session";

/**
 * Public candidate interview-confirm endpoints (INT-02).
 *
 * Unauthenticated — the signed link IS the authorisation. Tenant is
 * resolved from the interview row (looked up by token_hash), not from a
 * session. Mirrors /api/offers (Module 4): every attempt — success,
 * expired, already-confirmed — records a signed_link_uses row (which is
 * the append-only audit log), and the single-use discipline is the
 * partial UNIQUE on (tenant_id, token_hash) WHERE successful=true.
 *
 * Action string: `candidate.confirm_interview`.
 *
 * N2a adds recording consent to this same surface — see the header on
 * POST /confirm/:token/recording-consent for why the withdrawal path has to
 * be a SEPARATE route rather than more fields on the single-use confirm.
 *
 * N4.3a adds the AI first round (/ai/:token) under action
 * `candidate.ai_interview` — same verify → resolve-tenant-from-hash →
 * record-the-attempt shape, but a MULTI-USE link, because the round is walked
 * one question at a time across several requests. See the block header above
 * GET /ai/:token for what that changes about signed_link_uses.
 */
export const interviewsRoutes = new Hono();

interface InterviewRow {
  id: string;
  tenant_id: string;
  status: string;
  round_name: string;
  scheduled_start: Date | string | null;
  duration_minutes: number;
  mode: string;
  meeting_url: string | null;
  candidate_confirmed_at: Date | string | null;
  recording_requested: boolean;
  candidate_full_name: string | null;
  company_name: string;
  position_title: string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

async function loadInterviewByHash(tokenHash: string): Promise<InterviewRow | undefined> {
  const [row] = await poolSql<InterviewRow[]>`
    SELECT
      i.id,
      i.tenant_id,
      i.status,
      i.round_name,
      i.scheduled_start,
      i.duration_minutes,
      i.mode,
      i.meeting_url,
      i.candidate_confirmed_at,
      i.recording_requested,
      p.full_name AS candidate_full_name,
      pos.title AS position_title,
      t.display_name AS company_name
    FROM public.interviews i
    JOIN public.applications a ON a.id = i.application_id
    JOIN public.candidates c ON c.id = a.candidate_id
    JOIN public.persons p ON p.id = c.person_id
    JOIN public.requisitions r ON r.id = i.requisition_id
    JOIN public.positions pos ON pos.id = r.position_id
    JOIN public.tenants t ON t.id = i.tenant_id
    WHERE i.confirm_signed_link_token_hash = ${tokenHash}
    LIMIT 1
  `;
  return row;
}

const CONFIRM_ACTION = "candidate.confirm_interview";

/**
 * The append-only attempt log for both surfaces on this router.
 *
 * `action` is a parameter rather than the confirm constant it used to be
 * because N4.3a's AI-interview link is a second action on the same table, and
 * two copies of an error-swallowing audit writer is exactly how one of them
 * quietly stops writing.
 */
async function recordLinkUse(
  tenantId: string,
  tokenHash: string,
  action: string,
  subjectId: string,
  ip: string | null,
  successful: boolean,
  failureReason: string | null,
): Promise<void> {
  try {
    await poolSql`
      INSERT INTO public.signed_link_uses
        (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful, failure_reason)
      VALUES (${tenantId}, ${tokenHash}, ${action}, ${subjectId},
              ${ip}, ${successful}, ${failureReason})
    `;
  } catch (err) {
    // Partial unique on (tenant, token_hash) WHERE successful=true blocks a
    // second successful redemption; failed records can stack.
    baseLog.warn(
      { err, subject_id: subjectId, action, successful },
      "interviews.record_link_use_skipped",
    );
  }
}

/**
 * Bodies on these routes are OPTIONAL and candidate-supplied — an absent or
 * malformed one must degrade to "no fields", never to a 500 that costs the
 * candidate their confirmation. (The pre-N2a confirm route took no body at
 * all, and callers still send none.)
 */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await c.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // No body, or not JSON. Both are "the candidate answered nothing".
  }
  return {};
}

/** Provenance legs for the consent log, from the request the candidate made. */
function consentProvenance(c: Context): { ip: string | null; userAgent: string | null } {
  return {
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

/**
 * GET /api/interviews/confirm/:token
 *
 * Public — the candidate confirm page renders the round summary from this.
 * Does NOT consume the link (no signed_link_uses row); consumption happens
 * on POST. That deliberate non-consumption is what keeps this page reachable
 * AFTER confirmation, which is what makes a withdrawal control possible at
 * all — see POST /confirm/:token/recording-consent.
 *
 * N2a adds this round's own recording state (the recruiter's ask, the
 * candidate's effective consent, and the disclosure copy + version to render
 * it under) so N2b can show the right control. Nothing beyond THIS
 * interview's consent state is exposed.
 */
interviewsRoutes.get("/confirm/:token", async (c) => {
  const token = c.req.param("token");
  const verify = verifyLink(token);
  if (!verify.ok) return c.json({ ok: false, reason: verify.reason }, 400);
  if (verify.payload.action !== CONFIRM_ACTION) {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }

  const row = await loadInterviewByHash(verify.payload.tokenHash);
  if (!row) return c.json({ ok: false, reason: "interview_not_found" }, 404);

  const recordingConsent = await resolveRecordingConsent(poolSql, row.tenant_id, row.id);

  return c.json({
    ok: true,
    interviewId: row.id,
    status: row.status,
    candidateName: row.candidate_full_name ?? "there",
    companyName: row.company_name,
    positionTitle: row.position_title,
    roundName: row.round_name,
    scheduledStart: toIso(row.scheduled_start),
    durationMinutes: row.duration_minutes,
    mode: row.mode,
    meetingUrl: row.meeting_url,
    alreadyConfirmedAt: toIso(row.candidate_confirmed_at),
    recordingRequested: row.recording_requested,
    recordingConsent,
    // Copy + version served together so the wording the candidate sees can
    // never drift from the version the POST stamps onto their consent row.
    recordingConsentDisclosure: RECORDING_CONSENT_DISCLOSURE,
  });
});

/**
 * POST /api/interviews/confirm/:token
 *
 * Verify signature + action, single-use via signed_link_uses, stamp
 * candidate_confirmed_at. Idempotent-friendly: a cancelled round is
 * `already_cancelled`; a second use is `already_confirmed`.
 *
 * N2a: the body may carry an OPTIONAL `recordingConsent` boolean, captured
 * in the SAME request as the confirmation — one candidate interaction, not
 * two. true → a 'granted' consent row, false → 'declined', ABSENT → no row
 * at all, because a candidate who confirmed without being asked (or without
 * answering) has not consented to anything and must not be recorded as
 * having done so.
 */
interviewsRoutes.post("/confirm/:token", async (c) => {
  const token = c.req.param("token");
  const { ip, userAgent } = consentProvenance(c);
  const body = await readJsonBody(c);
  const consentAnswer = typeof body.recordingConsent === "boolean" ? body.recordingConsent : null;

  const verify = verifyLink(token);
  if (!verify.ok) {
    baseLog.warn({ reason: verify.reason, ip }, "interviews.confirm.verify_rejected");
    return c.json({ ok: false, reason: verify.reason }, 400);
  }
  if (verify.payload.action !== CONFIRM_ACTION) {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }

  const tokenHash = verify.payload.tokenHash;
  const row = await loadInterviewByHash(tokenHash);
  if (!row) return c.json({ ok: false, reason: "interview_not_found" }, 404);

  if (row.status === "cancelled") {
    await recordLinkUse(row.tenant_id, tokenHash, CONFIRM_ACTION, row.id, ip, false, "cancelled");
    return c.json({ ok: false, reason: "already_cancelled" }, 409);
  }
  if (row.candidate_confirmed_at) {
    await recordLinkUse(
      row.tenant_id,
      tokenHash,
      CONFIRM_ACTION,
      row.id,
      ip,
      false,
      "already_confirmed",
    );
    return c.json({ ok: false, reason: "already_confirmed" }, 409);
  }

  // Atomic stamp: only the row still unconfirmed wins; a concurrent second
  // click fails the WHERE and gets already_confirmed.
  const [updated] = await poolSql<{ candidate_confirmed_at: Date | string }[]>`
    UPDATE public.interviews
    SET candidate_confirmed_at = now(), updated_at = now()
    WHERE id = ${row.id} AND candidate_confirmed_at IS NULL AND status <> 'cancelled'
    RETURNING candidate_confirmed_at
  `;
  if (!updated) {
    await recordLinkUse(
      row.tenant_id,
      tokenHash,
      CONFIRM_ACTION,
      row.id,
      ip,
      false,
      "concurrent_resolve",
    );
    return c.json({ ok: false, reason: "already_confirmed" }, 409);
  }

  await recordLinkUse(row.tenant_id, tokenHash, CONFIRM_ACTION, row.id, ip, true, null);

  // The confirmation is the PRIMARY action and is already committed above.
  // A consent-write failure is logged and swallowed rather than allowed to
  // turn a successful confirmation into a 500 the candidate would retry into
  // `already_confirmed` — the same posture recordLinkUse takes.
  let recordingConsent: EffectiveRecordingConsent | null = null;
  if (consentAnswer !== null) {
    try {
      recordingConsent = await recordRecordingConsent(poolSql, {
        tenantId: row.tenant_id,
        interviewId: row.id,
        decision: consentAnswer ? "granted" : "declined",
        capturedVia: CONSENT_VIA_CANDIDATE_LINK,
        ipAddress: ip,
        userAgent,
      });
    } catch (err) {
      baseLog.error(
        { err, interview_id: row.id },
        "interviews.confirm.recording_consent_write_failed",
      );
    }
  }

  return c.json({
    ok: true,
    interviewId: row.id,
    confirmedAt: toIso(updated.candidate_confirmed_at),
    recordingConsent,
  });
});

/**
 * POST /api/interviews/confirm/:token/recording-consent
 *
 * Change the recording decision AFTER the confirm link has been redeemed.
 * Body: { decision: 'granted' | 'withdrawn' }.
 *
 * WHY THIS IS A SEPARATE ROUTE. POST /confirm/:token is SINGLE-USE — the
 * partial unique on signed_link_uses (tenant_id, token_hash) WHERE
 * successful = true means it can only ever be redeemed once. Consent
 * captured only there could therefore never be taken back, which would make
 * the append-only, withdrawable consent log a lie. GET /confirm/:token
 * deliberately does NOT consume the link, so the confirm page stays
 * reachable after confirmation; this route is the write side of that, and
 * it is NOT single-use.
 *
 * IT DOES NOT WRITE A signed_link_uses ROW. A `successful = true` row would
 * be rejected by that partial unique, and writing one would corrupt the
 * meaning of "the confirm link was redeemed" — that fact belongs to the
 * confirmation, not to a later change of mind. The consent table IS the
 * audit trail for this route: append-only (no UPDATE/DELETE policy under
 * FORCE RLS), with ip_address, user_agent and captured_at on every row.
 *
 * Idempotent-friendly: re-sending the same decision simply appends another
 * row and the resolver returns the same effective state. There is
 * deliberately no unique to "deduplicate" that — one would break withdrawal.
 */
interviewsRoutes.post("/confirm/:token/recording-consent", async (c) => {
  const token = c.req.param("token");
  const { ip, userAgent } = consentProvenance(c);

  // Same signature + action verification as the confirm routes — the signed
  // link is the only authorisation this surface has.
  const verify = verifyLink(token);
  if (!verify.ok) {
    baseLog.warn({ reason: verify.reason, ip }, "interviews.recording_consent.verify_rejected");
    return c.json({ ok: false, reason: verify.reason }, 400);
  }
  if (verify.payload.action !== CONFIRM_ACTION) {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }

  const body = await readJsonBody(c);
  const decision = body.decision;
  if (decision !== "granted" && decision !== "withdrawn") {
    // 'declined' is reachable only at confirm time (it answers "may we?");
    // once answered, the candidate grants or withdraws.
    return c.json({ ok: false, reason: "invalid_decision" }, 400);
  }

  const row = await loadInterviewByHash(verify.payload.tokenHash);
  if (!row) return c.json({ ok: false, reason: "interview_not_found" }, 404);
  if (row.status === "cancelled") {
    return c.json({ ok: false, reason: "already_cancelled" }, 409);
  }

  const recordingConsent = await recordRecordingConsent(poolSql, {
    tenantId: row.tenant_id,
    interviewId: row.id,
    decision: decision as RecordingConsentDecision,
    capturedVia: CONSENT_VIA_CANDIDATE_LINK,
    ipAddress: ip,
    userAgent,
  });

  return c.json({ ok: true, interviewId: row.id, recordingConsent });
});

/* ═══════════════════════ N4.3a — the AI first round ═══════════════════════
 *
 * The candidate's whole experience of an `ai_async` round, on the same
 * unauthenticated shape as the confirm routes above: verify the signature,
 * check the ACTION (a confirm token must not open an interview and vice
 * versa), resolve the tenant FROM the token hash, and record the attempt.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS LINK IS MULTI-USE, AND signed_link_uses IS WRITTEN ACCORDINGLY
 * ─────────────────────────────────────────────────────────────────────────
 * The confirm link is redeemed once and its `successful = true` row IS that
 * redemption. An interview is walked over many requests — start, an answer
 * per question, submit — so the partial UNIQUE on (tenant_id, token_hash)
 * WHERE successful = true can only ever admit ONE of them. Rather than let
 * recordLinkUse swallow the rest and leave a log that silently records the
 * first request and nothing after it, exactly one event is written as
 * successful: THE SUBMIT. That is the redemption that matters — "this link
 * produced a completed round" — and it is the only candidate action here
 * without an audit trail of its own. The start has one (an
 * `interview_recording_consents` row, with ip and user agent), and every
 * answer has one (`turn_state`, plus the audit trigger 0119 put on
 * ai_interview_sessions).
 *
 * REFUSALS ARE ALWAYS WRITTEN, on every route, because `successful = false`
 * rows stack freely and a refused attempt on an expired or cancelled round is
 * exactly the kind of thing someone asks about later.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT NEVER CROSSES THIS BOUNDARY
 * ─────────────────────────────────────────────────────────────────────────
 * `rubricKey`, and any question the candidate is not currently on. Both are
 * enforced in ../lib/ai-interview-session.ts (`toCandidateQuestion` copies
 * two fields; `currentQuestionIndex` walks the set server-side) rather than
 * here, so a second route added later cannot forget.
 */

/** Verify + action-check + load, or the HTTP answer for why not. */
async function resolveAiSession(
  c: Context,
): Promise<
  { ok: true; row: AiInterviewSessionRow; tokenHash: string } | { ok: false; response: Response }
> {
  // `?? ""` because Hono types a bare Context's params as possibly absent;
  // an empty token fails verifyLink as `malformed`, which is the honest
  // answer for a route that was somehow reached without one.
  const verify = verifyLink(c.req.param("token") ?? "");
  if (!verify.ok) {
    // `expired` here is the TOKEN's own expiry, which is minted from the same
    // instant as the session's `expires_at` (issueSession), so the two can
    // never disagree about whether a round is still open.
    return { ok: false, response: c.json({ ok: false, reason: verify.reason }, 400) };
  }
  if (verify.payload.action !== AI_INTERVIEW_LINK_ACTION) {
    return { ok: false, response: c.json({ ok: false, reason: "wrong_action" }, 400) };
  }

  const found = await loadSessionByTokenHash(poolSql, verify.payload.tokenHash);
  if (!found) {
    return { ok: false, response: c.json({ ok: false, reason: "interview_not_found" }, 404) };
  }
  // Lazy expiry, stamped on access — see the lib header for why there is no
  // sweep. Runs before every read AND every write.
  const row = await expireIfLapsed(poolSql, found);
  return { ok: true, row, tokenHash: verify.payload.tokenHash };
}

/**
 * HTTP status per refusal. Deliberately explicit rather than "everything is a
 * 409": the candidate surface renders different screens for "your link ran
 * out" and "that answer was too long", and a browser retry policy treats them
 * differently too.
 */
const REFUSAL_STATUS: Record<CandidateRefusal, 400 | 403 | 409> = {
  not_issued: 409,
  expired: 409,
  cancelled: 409,
  already_submitted: 409,
  not_started: 409,
  consent_required: 403,
  no_current_question: 409,
  not_current_question: 409,
  invalid_answer: 400,
  invalid_content_type: 400,
  too_large: 400,
  media_missing: 400,
  media_shrank: 400,
  content_type_changed: 409,
};

/** Turn a lib refusal into the HTTP answer + the audit row it deserves. */
async function refusalResponse(
  c: Context,
  row: AiInterviewSessionRow,
  tokenHash: string,
  ip: string | null,
  // The REFUSAL arm specifically, not the union: this is only ever reached
  // after a caller has narrowed on `!result.ok`, and typing it as the union
  // would force a redundant `.refusal ?? fallback` whose fallback could only
  // ever be a lie about why the candidate was turned away.
  result: CandidateRefusalResult,
): Promise<Response> {
  const refusal = result.refusal;
  await recordLinkUse(
    row.tenant_id,
    tokenHash,
    AI_INTERVIEW_LINK_ACTION,
    row.session_id,
    ip,
    false,
    refusal,
  );
  return c.json({ ok: false, reason: refusal, message: result.message }, REFUSAL_STATUS[refusal]);
}

/**
 * GET /api/interviews/ai/:token
 *
 * The candidate screen's only read. DOES NOT CONSUME THE LINK — no
 * signed_link_uses row, success or failure — for the same reason
 * GET /confirm/:token does not: non-consumption is what makes RESUMING
 * possible. A candidate whose browser dies half-way through a round has to be
 * able to reopen the same link and be handed the question they were on.
 *
 * Returns the round context, the disclosure copy + version, the current
 * consent state, and EXACTLY ONE QUESTION — the one they are on, and only
 * once the round has actually started. Never `rubricKey`, never the questions
 * after it.
 */
interviewsRoutes.get("/ai/:token", async (c) => {
  const resolved = await resolveAiSession(c);
  if (!resolved.ok) return resolved.response;
  const { row } = resolved;

  const consent = await resolveRecordingConsent(poolSql, row.tenant_id, row.interview_id);
  return c.json({ ok: true, ...toCandidateView(row, consent) });
});

/**
 * POST /api/interviews/ai/:token/start
 *
 * Body: { consent: boolean }. Capture the recording decision under THIS
 * surface's disclosure version and `captured_via = 'ai_interview_link'`, then
 * move issued → in_progress and stamp started_at.
 *
 * A DECLINE IS A 403 WITH AN EXPLANATION, NOT A DEAD END. This round is the
 * recording, so there is nothing to run without it — unlike a human round,
 * which proceeds unrecorded. The refusal says so, says nothing was kept, and
 * says a recruiter will pick it up. The decision itself is still written to
 * the append-only consent log, because a refusal is a fact about what the
 * candidate was asked and what they answered.
 *
 * `consent` ABSENT is not a decline — it is a malformed request, and it must
 * not write a 'declined' row against someone who never answered.
 */
interviewsRoutes.post("/ai/:token/start", async (c) => {
  const resolved = await resolveAiSession(c);
  if (!resolved.ok) return resolved.response;
  const { row, tokenHash } = resolved;
  const { ip, userAgent } = consentProvenance(c);

  const body = await readJsonBody(c);
  if (typeof body.consent !== "boolean") {
    await recordLinkUse(
      row.tenant_id,
      tokenHash,
      AI_INTERVIEW_LINK_ACTION,
      row.session_id,
      ip,
      false,
      "consent_missing",
    );
    return c.json({ ok: false, reason: "consent_missing" }, 400);
  }

  const result = await startSession(poolSql, row, {
    consentGranted: body.consent,
    ipAddress: ip,
    userAgent,
  });
  if (!result.ok) return refusalResponse(c, row, tokenHash, ip, result);
  return c.json({ ok: true, ...result.value.view });
});

/**
 * POST /api/interviews/ai/:token/answer/upload-url
 *
 * Body: { questionKey, contentType, sizeBytes }. Mints the signed PUT for
 * this answer's checkpoint and creates/refreshes the round's single
 * `interview_recordings` row. The API stays out of the byte path entirely —
 * N3.4a's argument, and more so here, where the uploader is a candidate's
 * phone on a hotel wifi.
 *
 * Typed answers never call this. They have no media.
 */
interviewsRoutes.post("/ai/:token/answer/upload-url", async (c) => {
  const resolved = await resolveAiSession(c);
  if (!resolved.ok) return resolved.response;
  const { row, tokenHash } = resolved;
  const ip = consentProvenance(c).ip;

  const body = await readJsonBody(c);
  const questionKey = typeof body.questionKey === "string" ? body.questionKey : "";
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : -1;
  if (!questionKey || !contentType || sizeBytes < 0) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await createAnswerUploadUrl(poolSql, row, { questionKey, contentType, sizeBytes });
  if (!result.ok) return refusalResponse(c, row, tokenHash, ip, result);
  return c.json({ ok: true, ...result.value });
});

/**
 * POST /api/interviews/ai/:token/answer
 *
 * Body: { questionKey, mode: 'voice' | 'typed', text?, startMs?, endMs? }.
 * The completion call for one answer: for a voice answer it verifies the
 * object really landed and enforces the cumulative-upload contract; for a
 * typed one it stores the text. Either way the mode is recorded, and the turn
 * advances to the next question.
 */
interviewsRoutes.post("/ai/:token/answer", async (c) => {
  const resolved = await resolveAiSession(c);
  if (!resolved.ok) return resolved.response;
  const { row, tokenHash } = resolved;
  const ip = consentProvenance(c).ip;

  const body = await readJsonBody(c);
  const questionKey = typeof body.questionKey === "string" ? body.questionKey : "";
  const mode = body.mode;
  if (!questionKey || (mode !== "voice" && mode !== "typed")) {
    return c.json({ ok: false, reason: "invalid_request" }, 400);
  }

  const result = await recordAnswer(poolSql, row, {
    questionKey,
    mode,
    text: typeof body.text === "string" ? body.text : null,
    startMs: typeof body.startMs === "number" ? body.startMs : null,
    endMs: typeof body.endMs === "number" ? body.endMs : null,
  });
  if (!result.ok) return refusalResponse(c, row, tokenHash, ip, result);
  return c.json({ ok: true, answer: result.value.answer, ...result.value.view });
});

/**
 * POST /api/interviews/ai/:token/submit
 *
 * Body: { durationSeconds? }. Finishes the round: one recording row for the
 * round's single audio object, status → submitted, and THE ENQUEUE onto
 * transcript_outbox, which is where N3's drain takes over.
 *
 * THE ONE `successful = true` signed_link_uses ROW IS WRITTEN HERE — see the
 * block header. A second submit is refused as `already_submitted` and writes
 * a failure row, so the partial unique is never contended.
 *
 * An all-typed round comes back `enqueued: false, recordingId: null`. That is
 * success, not a degraded outcome: there was no audio, so there is nothing to
 * transcribe, and the answers are in turn_state where N4.4 reads them.
 */
interviewsRoutes.post("/ai/:token/submit", async (c) => {
  const resolved = await resolveAiSession(c);
  if (!resolved.ok) return resolved.response;
  const { row, tokenHash } = resolved;
  const ip = consentProvenance(c).ip;

  const body = await readJsonBody(c);
  const result = await submitSession(poolSql, row, {
    durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : null,
  });
  if (!result.ok) return refusalResponse(c, row, tokenHash, ip, result);

  await recordLinkUse(
    row.tenant_id,
    tokenHash,
    AI_INTERVIEW_LINK_ACTION,
    row.session_id,
    ip,
    true,
    null,
  );

  const value = result.value;
  return c.json({
    ok: true,
    ...value.view,
    recordingId: value.recordingId,
    enqueued: value.enqueued,
  });
});
