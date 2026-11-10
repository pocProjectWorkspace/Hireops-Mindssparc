/**
 * PC-14 — the candidate's one-question check-in ("Are you still on track to
 * join on <date>?" Yes / Unsure / No + optional comment + optional 1–5
 * "how are you feeling about joining").
 *
 * The link is a signed link (action candidate.pre_joining_pulse, subject =
 * touchpoint id) whose SHA-256 the drain stored on the touchpoint, so a token
 * must both verify AND match the touchpoint it names. One answer per
 * check-in (UNIQUE on the touchpoint) — a second submit is "already
 * answered". "Unsure" / "No" raise a signal (the candidate's own comment, if
 * any, is the quote — their words verbatim, nothing inferred).
 */

import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { verifyLink } from "@hireops/notifications";
import { pulseAnswerSignal, type SubmitPulseResponseInput } from "@hireops/api-types";
import { formatJoiningDate, loadPreJoiningSettings, raiseRiskSignal } from "./journey";

type PgSqlClient = typeof poolSql;

export const PULSE_LINK_ACTION = "candidate.pre_joining_pulse";

interface PulseRow {
  touchpoint_id: string;
  tenant_id: string;
  journey_id: string;
  application_id: string;
  journey_status: string;
  joining_date: string;
  candidate_name: string | null;
  position_title: string;
  company_name: string;
  answered: boolean;
}

export type PulseLookup =
  | { ok: true; row: PulseRow; tokenHash: string }
  | { ok: false; reason: string; status: 400 | 404 };

export async function lookupPulse(sql: PgSqlClient, token: string): Promise<PulseLookup> {
  const v = verifyLink(token);
  if (!v.ok) return { ok: false, reason: v.reason, status: 400 };
  if (v.payload.action !== PULSE_LINK_ACTION)
    return { ok: false, reason: "wrong_action", status: 400 };
  const [row] = await sql<PulseRow[]>`
    SELECT
      tp.id AS touchpoint_id, tp.tenant_id, tp.journey_id, tp.application_id,
      j.status AS journey_status, j.joining_date::text AS joining_date,
      p.full_name AS candidate_name, pos.title AS position_title,
      t.display_name AS company_name,
      EXISTS (
        SELECT 1 FROM public.pre_joining_pulse_responses r
        WHERE r.tenant_id = tp.tenant_id AND r.touchpoint_id = tp.id
      ) AS answered
    FROM public.pre_joining_touchpoints tp
    JOIN public.pre_joining_journeys j ON j.tenant_id = tp.tenant_id AND j.id = tp.journey_id
    JOIN public.applications a ON a.tenant_id = tp.tenant_id AND a.id = tp.application_id
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    JOIN public.tenants t ON t.id = tp.tenant_id
    WHERE tp.id = ${v.payload.subjectId} AND tp.pulse_token_hash = ${v.payload.tokenHash}
    LIMIT 1
  `;
  if (!row) return { ok: false, reason: "not_found", status: 404 };
  return { ok: true, row, tokenHash: v.payload.tokenHash };
}

export function publicPulseView(row: PulseRow) {
  const first = (row.candidate_name ?? "").trim().split(/\s+/)[0] ?? "";
  return {
    candidateFirstName: first,
    companyName: row.company_name,
    positionTitle: row.position_title,
    joiningDate: row.joining_date,
    joiningDateFormatted: formatJoiningDate(row.joining_date),
    alreadyAnswered: row.answered,
    // A stopped journey (reneged / withdrawn / joined) no longer takes answers.
    open: row.journey_status === "active" && !row.answered,
  };
}

export type SubmitPulseOutcome =
  | { ok: true; signalRaised: boolean }
  | { ok: false; reason: string; status: 400 | 404 | 409 };

export async function submitPulse(
  sql: PgSqlClient,
  token: string,
  input: SubmitPulseResponseInput,
  opts: { ip: string | null; log: Logger },
): Promise<SubmitPulseOutcome> {
  const found = await lookupPulse(sql, token);
  if (!found.ok) return found;
  const { row, tokenHash } = found;
  if (row.answered) return { ok: false, reason: "already_answered", status: 409 };
  if (row.journey_status !== "active") return { ok: false, reason: "closed", status: 409 };

  const comment = input.comment?.trim() ? input.comment.trim() : null;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.pre_joining_pulse_responses
      (tenant_id, touchpoint_id, journey_id, application_id, on_track, feeling, comment)
    VALUES (${row.tenant_id}, ${row.touchpoint_id}, ${row.journey_id}, ${row.application_id},
            ${input.onTrack}, ${input.feeling ?? null}, ${comment})
    ON CONFLICT (tenant_id, touchpoint_id) DO NOTHING
    RETURNING id
  `;
  const responseId = inserted[0]?.id;
  if (!responseId) return { ok: false, reason: "already_answered", status: 409 };

  // Audit the redemption alongside every other signed-link use.
  await sql`
    INSERT INTO public.signed_link_uses
      (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful)
    VALUES (${row.tenant_id}, ${tokenHash}, ${PULSE_LINK_ACTION}, ${row.touchpoint_id}, ${opts.ip}, true)
    ON CONFLICT DO NOTHING
  `.catch((err: unknown) => opts.log.warn({ err }, "pre_joining.pulse_link_use_audit_failed"));

  const type = pulseAnswerSignal(input.onTrack);
  let signalRaised = false;
  if (type) {
    const settings = await loadPreJoiningSettings(sql, row.tenant_id);
    const r = await raiseRiskSignal(sql, {
      tenantId: row.tenant_id,
      applicationId: row.application_id,
      journeyId: row.journey_id,
      type,
      source: "pulse_response",
      quote: comment,
      pulseResponseId: responseId,
      settings,
      log: opts.log,
    });
    signalRaised = r.signalId !== null;
  }
  return { ok: true, signalRaised };
}
