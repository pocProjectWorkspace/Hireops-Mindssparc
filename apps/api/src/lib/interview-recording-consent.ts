/**
 * N2a — interview-recording consent: the single source of truth.
 *
 * Migration 0116 gave us an APPEND-ONLY consent log
 * (`interview_recording_consents`) and a separate recruiter intent flag
 * (`interviews.recording_requested`). This module is the only place that
 * knows how to turn those two facts into an answer to "may this round be
 * recorded?". The public confirm route, the tRPC procedures and (later) the
 * N3 upload/transcription pipeline all read it; nothing re-implements the
 * resolution, because a second implementation is exactly how a consent gate
 * silently drifts open.
 *
 * Three rules the shape here encodes:
 *
 *   1. ABSENCE IS NOT PERMISSION. No consent row at all means "never
 *      asked", and `resolveRecordingConsent` returns decision === null with
 *      permitted === false. A null must never be read as a grant.
 *
 *   2. THE LATEST ROW WINS. A withdrawal is a NEW ROW, never an UPDATE (the
 *      table has no UPDATE/DELETE RLS policy under FORCE RLS, so that is a
 *      database guarantee, not a convention). Effective state is therefore
 *      ORDER BY created_at DESC LIMIT 1, and granted → withdrawn → granted
 *      again is a legitimate history.
 *
 *   3. CONSENT IS NECESSARY BUT NOT SUFFICIENT. `canRecordInterview` also
 *      requires the recruiter's own `recording_requested` toggle. Two
 *      independent facts, both mandatory.
 *
 * Client shape: every function takes a postgres.js tagged-template client
 * rather than a `TenantBoundDb`, because the SAME logic has to run in two
 * places that do not share a handle — the UNAUTHENTICATED candidate confirm
 * route (`apps/api/src/routes/interviews.ts`, which has only the
 * service-role `poolSql`) and the tRPC procedures (`ctx.sql`, the same
 * service-role pool). That client BYPASSES RLS, so every statement below
 * carries an EXPLICIT `tenant_id` predicate — the router header's rule for
 * public procedures, applied here for the same reason.
 */

import { sql as poolSql } from "@hireops/db";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

/** The three decisions the 0116 CHECK allows. */
export type RecordingConsentDecision = "granted" | "declined" | "withdrawn";

/**
 * Capture seams, CHECK-pinned on `interview_recording_consents.captured_via`.
 *
 * `candidate_confirm_link` is the candidate's own action on the interview
 * confirm page — the only value 0116 allows.
 *
 * `internal_revocation` is a recruiter/HR-ops staff member recording a
 * withdrawal ON THE CANDIDATE'S BEHALF (a DPDPA request phoned or emailed
 * in after the signed link has expired — the link expires, the right to
 * withdraw does not). It REQUIRES migration 0117, which widens the CHECK;
 * until that is applied the insert fails with 23514 rather than silently
 * mis-attributing the withdrawal to the candidate.
 */
export const CONSENT_VIA_CANDIDATE_LINK = "candidate_confirm_link";
export const CONSENT_VIA_INTERNAL_REVOCATION = "internal_revocation";

/**
 * The disclosure copy version stamped onto every row this build writes.
 *
 * STORED ROWS REFERENCE THE VERSION THEY WERE CAPTURED UNDER, which is the
 * whole point of the column: it lets us answer "what exactly did this
 * candidate agree to?" months later. So changing ANY word of
 * RECORDING_CONSENT_DISCLOSURE below MUST bump this constant in the same
 * commit — a new wording under an old version is an unanswerable audit
 * question.
 */
export const RECORDING_CONSENT_VERSION = "2026-08-v1";

export interface RecordingConsentDisclosure {
  /** Always RECORDING_CONSENT_VERSION — served together so they can't drift. */
  version: string;
  title: string;
  /** Paragraphs, in order. */
  body: string[];
  grantLabel: string;
  declineLabel: string;
  withdrawLabel: string;
  /**
   * Hard-coded true. The surfaces do not read it; it exists so this object
   * cannot be copied into a UI without the reader tripping over the fact.
   */
  legalReviewRequired: true;
}

/**
 * ⚠️ PLACEHOLDER COPY — NOT LEGALLY REVIEWED, NOT FOR PRODUCTION. ⚠️
 *
 * This is honest plain-English drafting so N2b has something real to render
 * and so the version-stamping mechanism is exercised end to end. It is NOT
 * approved wording. The client's legally-approved disclosure text is a
 * PENDING INPUT; when it arrives, replace the strings below AND bump
 * RECORDING_CONSENT_VERSION.
 *
 * What the draft deliberately says, because these are the promises the
 * schema actually keeps: recording is optional, the interview happens either
 * way, and consent can be taken back at any time (0116 is append-only
 * precisely so a withdrawal is expressible).
 */
export const RECORDING_CONSENT_DISCLOSURE: RecordingConsentDisclosure = {
  version: RECORDING_CONSENT_VERSION,
  title: "May we record this interview?",
  body: [
    "We would like to record this interview round — audio and, where the round " +
      "is held over video, the meeting transcript — so the panel can write up " +
      "accurate notes afterwards instead of typing while you talk.",
    "The recording is used only to produce notes for this hiring process. It is " +
      "not shared outside the hiring team, and it is never used to score you " +
      "automatically — a person still makes every decision.",
    "Recording is optional. The interview goes ahead exactly the same way if you " +
      "say no, and saying no will not count against you.",
    "You can change your mind at any time, before or after the interview, using " +
      "this same link or by contacting your recruiter. If you withdraw, we stop " +
      "recording from that point.",
  ],
  grantLabel: "Yes, you may record this interview",
  declineLabel: "No, please do not record",
  withdrawLabel: "Withdraw my consent to recording",
  legalReviewRequired: true,
};

/**
 * The effective consent state for one interview — the latest row in the log,
 * flattened. `decision: null` means NO row exists: never asked, which is NOT
 * a grant.
 */
export interface EffectiveRecordingConsent {
  decision: RecordingConsentDecision | null;
  /** When the effective decision was captured (ISO), or null if never asked. */
  decidedAt: string | null;
  /** The disclosure version the candidate actually saw, or null. */
  consentVersion: string | null;
  /** Which seam captured it, or null. */
  capturedVia: string | null;
  /** decision === 'granted'. Absence and 'declined'/'withdrawn' are all false. */
  permitted: boolean;
}

/** Recruiter intent + candidate consent + the AND of the two. */
export interface RecordingGate {
  interviewId: string;
  /** interviews.recording_requested — the recruiter's separate ask. */
  recordingRequested: boolean;
  consent: EffectiveRecordingConsent;
  /** recordingRequested AND consent.permitted. See canRecordInterview. */
  canRecord: boolean;
}

export interface RecordConsentInput {
  tenantId: string;
  interviewId: string;
  decision: RecordingConsentDecision;
  capturedVia: string;
  /** Raw request IP; anything that isn't a literal address is stored as null. */
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Defaults to RECORDING_CONSENT_VERSION; pass only to replay history. */
  consentVersion?: string;
}

/** user_agent is free text on an append-only table — bound what we keep. */
const USER_AGENT_MAX = 512;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/**
 * `ip_address` is `inet`, and a malformed value raises 22P02 at Bind — which
 * on the confirm route would turn a bad `x-forwarded-for` header into a lost
 * consent write. Anything that isn't recognisably an address literal is
 * stored as NULL instead: the provenance leg degrades, the consent record
 * survives. (signed_link_uses gets away with passing the header through raw
 * because recordLinkUse swallows its own errors.)
 */
export function normaliseInetOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 45) return null;

  const v4 = IPV4_RE.exec(value);
  if (v4) {
    return v4.slice(1).every((octet) => Number(octet) <= 255 && !/^0\d/.test(octet)) ? value : null;
  }
  // IPv6: hex groups + colons only, at most 8 groups, at most one "::".
  if (!value.includes(":") || !IPV6_RE.test(value)) return null;
  if (value.split("::").length > 2) return null;
  if (value.split(":").filter((g) => g.length > 0).length > 8) return null;
  return value;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** No row at all — "never asked". Deliberately NOT the same as a decline. */
function neverAsked(): EffectiveRecordingConsent {
  return {
    decision: null,
    decidedAt: null,
    consentVersion: null,
    capturedVia: null,
    permitted: false,
  };
}

interface ConsentRow {
  decision: string;
  captured_at: Date | string;
  consent_version: string;
  captured_via: string;
}

/**
 * The effective consent for one interview: the LATEST row in the append-only
 * log, or "never asked" when there is none.
 *
 * ORDER BY created_at DESC, refusal-first, id DESC — the index
 * (tenant_id, interview_id, created_at DESC) serves the first key. The second
 * key is a FAIL-CLOSED tie-break, and it is deliberate rather than cosmetic:
 * if a grant and a withdrawal ever land in the same microsecond, ordering by
 * id would pick between them on a random uuid, and half the time that answer
 * is "keep recording after the candidate withdrew". The harm is asymmetric —
 * wrongly refusing to record costs a convenience, wrongly recording is a
 * consent breach — so a tie resolves to the refusal, always. The id leg
 * remains last so the result is still fully deterministic.
 */
export async function resolveRecordingConsent(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<EffectiveRecordingConsent> {
  const [row] = await sql<ConsentRow[]>`
    SELECT decision, captured_at, consent_version, captured_via
    FROM public.interview_recording_consents
    WHERE tenant_id = ${tenantId} AND interview_id = ${interviewId}
    ORDER BY created_at DESC, (decision = 'granted') ASC, id DESC
    LIMIT 1
  `;
  if (!row) return neverAsked();

  return {
    decision: row.decision as RecordingConsentDecision,
    decidedAt: toIso(row.captured_at),
    consentVersion: row.consent_version,
    capturedVia: row.captured_via,
    // 'declined' and 'withdrawn' are both refusals; only a grant permits.
    permitted: row.decision === "granted",
  };
}

/**
 * Append one consent event and return the resulting effective state.
 *
 * INSERT ONLY — never an UPDATE of a prior row. Re-sending the same decision
 * is harmless: it appends another row and the resolver returns the same
 * answer, which is what makes the candidate-facing route safe to retry.
 *
 * The state is RE-RESOLVED after the write rather than synthesised from the
 * inserted row: one cheap index read buys us the guarantee that callers see
 * exactly what every other reader will see.
 */
export async function recordRecordingConsent(
  sql: PgSqlClient,
  input: RecordConsentInput,
): Promise<EffectiveRecordingConsent> {
  const userAgent = input.userAgent ? input.userAgent.slice(0, USER_AGENT_MAX) : null;
  await sql`
    INSERT INTO public.interview_recording_consents
      (tenant_id, interview_id, decision, consent_version, captured_via, ip_address, user_agent)
    VALUES (${input.tenantId}, ${input.interviewId}, ${input.decision},
            ${input.consentVersion ?? RECORDING_CONSENT_VERSION}, ${input.capturedVia},
            ${normaliseInetOrNull(input.ipAddress)}, ${userAgent})
  `;
  return resolveRecordingConsent(sql, input.tenantId, input.interviewId);
}

/**
 * THE GATE. Returns null when the interview doesn't exist in this tenant so
 * the caller can map that to its own not-found posture.
 *
 * Everything downstream (the N3 upload surface, the transcription drain)
 * asks this and nothing else.
 */
export async function canRecordInterview(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
): Promise<RecordingGate | null> {
  const [row] = await sql<{ recording_requested: boolean }[]>`
    SELECT recording_requested
    FROM public.interviews
    WHERE tenant_id = ${tenantId} AND id = ${interviewId}
    LIMIT 1
  `;
  if (!row) return null;

  const consent = await resolveRecordingConsent(sql, tenantId, interviewId);
  return {
    interviewId,
    recordingRequested: row.recording_requested,
    consent,
    // BOTH must hold. Consent is NECESSARY BUT NOT SUFFICIENT: a candidate's
    // permission does not authorise a recording the recruiter never asked
    // for, and the recruiter's ask does not authorise one the candidate
    // never permitted. Neither side of this && is redundant.
    canRecord: row.recording_requested && consent.permitted,
  };
}

/**
 * Set the recruiter's `recording_requested` intent and return the resulting
 * EFFECTIVE recordability — so a caller can show the honest state ("asked
 * for, but the candidate hasn't agreed") rather than assuming the toggle was
 * enough. Flipping it on does not imply, create or refresh consent.
 *
 * Returns null when the interview doesn't exist in this tenant.
 */
export async function setRecordingRequested(
  sql: PgSqlClient,
  tenantId: string,
  interviewId: string,
  requested: boolean,
): Promise<RecordingGate | null> {
  const [row] = await sql<{ id: string }[]>`
    UPDATE public.interviews
    SET recording_requested = ${requested}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${interviewId}
    RETURNING id
  `;
  if (!row) return null;
  return canRecordInterview(sql, tenantId, interviewId);
}
