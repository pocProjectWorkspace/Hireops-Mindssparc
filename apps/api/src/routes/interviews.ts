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

async function recordLinkUse(
  tenantId: string,
  tokenHash: string,
  interviewId: string,
  ip: string | null,
  successful: boolean,
  failureReason: string | null,
): Promise<void> {
  try {
    await poolSql`
      INSERT INTO public.signed_link_uses
        (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful, failure_reason)
      VALUES (${tenantId}, ${tokenHash}, 'candidate.confirm_interview', ${interviewId},
              ${ip}, ${successful}, ${failureReason})
    `;
  } catch (err) {
    // Partial unique on (tenant, token_hash) WHERE successful=true blocks a
    // second successful redemption; failed records can stack.
    baseLog.warn(
      { err, interview_id: interviewId, successful },
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
  if (verify.payload.action !== "candidate.confirm_interview") {
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
  if (verify.payload.action !== "candidate.confirm_interview") {
    return c.json({ ok: false, reason: "wrong_action" }, 400);
  }

  const tokenHash = verify.payload.tokenHash;
  const row = await loadInterviewByHash(tokenHash);
  if (!row) return c.json({ ok: false, reason: "interview_not_found" }, 404);

  if (row.status === "cancelled") {
    await recordLinkUse(row.tenant_id, tokenHash, row.id, ip, false, "cancelled");
    return c.json({ ok: false, reason: "already_cancelled" }, 409);
  }
  if (row.candidate_confirmed_at) {
    await recordLinkUse(row.tenant_id, tokenHash, row.id, ip, false, "already_confirmed");
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
    await recordLinkUse(row.tenant_id, tokenHash, row.id, ip, false, "concurrent_resolve");
    return c.json({ ok: false, reason: "already_confirmed" }, 409);
  }

  await recordLinkUse(row.tenant_id, tokenHash, row.id, ip, true, null);

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
  if (verify.payload.action !== "candidate.confirm_interview") {
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
