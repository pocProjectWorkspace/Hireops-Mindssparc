import { Hono } from "hono";
import { sql as poolSql } from "@hireops/db";
import { verifyLink } from "@hireops/notifications";
import { baseLog } from "../lib/observability";

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
 * GET /api/interviews/confirm/:token
 *
 * Public — the candidate confirm page renders the round summary from this.
 * Does NOT consume the link (no signed_link_uses row); consumption happens
 * on POST.
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
  });
});

/**
 * POST /api/interviews/confirm/:token
 *
 * Verify signature + action, single-use via signed_link_uses, stamp
 * candidate_confirmed_at. Idempotent-friendly: a cancelled round is
 * `already_cancelled`; a second use is `already_confirmed`.
 */
interviewsRoutes.post("/confirm/:token", async (c) => {
  const token = c.req.param("token");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

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
  return c.json({
    ok: true,
    interviewId: row.id,
    confirmedAt: toIso(updated.candidate_confirmed_at),
  });
});
