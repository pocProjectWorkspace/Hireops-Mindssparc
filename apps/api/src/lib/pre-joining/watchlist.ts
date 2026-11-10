/**
 * PC-16 — joining-risk watchlist + engagement timeline reads, and PC-17
 * renege capture.
 *
 * FACTS ONLY. Every column is something that happened: when we last wrote,
 * when they last wrote, what they last answered, which signals are open (each
 * a thing they said), how many check-ins went unanswered. There is no risk
 * score, ranking or prediction — sorting is by the facts themselves.
 *
 * Scope: admin / hr_head see the tenant; a recruiter sees the applications
 * they own (assigned recruiter, or the requisition's primary recruiter when
 * none is assigned). Callers pass `recruiterMembershipId` for the latter.
 */

import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import {
  RISK_SIGNAL_LABELS,
  daysBetweenIso,
  localParts,
  preJoiningStepKeySchema,
  riskSignalTypeSchema,
  type EngagementTimelineItem,
  type GetEngagementTimelineOutput,
  type JoiningWatchlistRow,
  type PulseOnTrack,
  type RecordRenegeInput,
  type RenegeHistoryRow,
  type RiskSignalType,
} from "@hireops/api-types";
import { loadPreJoiningSettings, stopPreJoiningJourney } from "./journey";
import { listWelcomeGuideViews } from "./welcome-guide";

type PgSqlClient = typeof poolSql;

function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asSignalType(v: string): RiskSignalType | null {
  const p = riskSignalTypeSchema.safeParse(v);
  return p.success ? p.data : null;
}

export async function listJoiningWatchlist(
  sql: PgSqlClient,
  args: { tenantId: string; recruiterMembershipId: string | null; now?: Date },
): Promise<{ rows: JoiningWatchlistRow[]; reneged: RenegeHistoryRow[] }> {
  const { tenantId, recruiterMembershipId } = args;
  const settings = await loadPreJoiningSettings(sql, tenantId);
  const today = localParts(args.now ?? new Date(), settings.quietHours.timezone).date;
  const scope = recruiterMembershipId
    ? sql`AND COALESCE(a.assigned_recruiter_membership_id, r.primary_recruiter_id) = ${recruiterMembershipId}`
    : sql``;

  const raw = await sql<
    {
      application_id: string;
      candidate_id: string;
      candidate_name: string | null;
      role: string;
      business_unit: string | null;
      recruiter_name: string | null;
      joining_date: string;
      journey_status: string | null;
      last_sent_at: Date | string | null;
      last_received_at: Date | string | null;
      last_pulse_answer: string | null;
      last_pulse_at: Date | string | null;
      missed_pulses: number | string;
    }[]
  >`
    SELECT
      a.id AS application_id,
      a.candidate_id,
      pe.full_name AS candidate_name,
      pos.title AS role,
      bu.name AS business_unit,
      COALESCE(u.display_name, au.email) AS recruiter_name,
      o.joining_date::text AS joining_date,
      j.status AS journey_status,
      (SELECT MAX(tp.sent_at) FROM public.pre_joining_touchpoints tp
        WHERE tp.tenant_id = a.tenant_id AND tp.application_id = a.id AND tp.status = 'sent')
        AS last_sent_at,
      (SELECT MAX(m.received_at) FROM public.candidate_inbound_messages m
        WHERE m.tenant_id = a.tenant_id AND m.application_id = a.id) AS last_received_at,
      lp.on_track AS last_pulse_answer,
      lp.responded_at AS last_pulse_at,
      (SELECT COUNT(*) FROM public.pre_joining_touchpoints tp
        WHERE tp.tenant_id = a.tenant_id AND tp.application_id = a.id
          AND tp.status = 'sent' AND tp.carries_pulse
          AND tp.sent_at < now() - interval '3 days'
          AND NOT EXISTS (
            SELECT 1 FROM public.pre_joining_pulse_responses pr
            WHERE pr.tenant_id = tp.tenant_id AND pr.touchpoint_id = tp.id
          )) AS missed_pulses
    FROM public.applications a
    JOIN LATERAL (
      SELECT joining_date FROM public.offers
      WHERE tenant_id = a.tenant_id AND application_id = a.id AND status = 'accepted'
      ORDER BY accepted_at DESC NULLS LAST, created_at DESC LIMIT 1
    ) o ON true
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons pe ON pe.tenant_id = c.tenant_id AND pe.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    LEFT JOIN public.business_units bu ON bu.tenant_id = pos.tenant_id AND bu.id = pos.business_unit_id
    LEFT JOIN public.tenant_user_memberships tum
      ON tum.tenant_id = a.tenant_id
     AND tum.id = COALESCE(a.assigned_recruiter_membership_id, r.primary_recruiter_id)
    LEFT JOIN public.users u ON u.id = tum.user_id
    LEFT JOIN auth.users au ON au.id = tum.user_id
    LEFT JOIN public.onboarding_cases oc ON oc.tenant_id = a.tenant_id AND oc.application_id = a.id
    LEFT JOIN public.pre_joining_journeys j ON j.tenant_id = a.tenant_id AND j.application_id = a.id
    LEFT JOIN LATERAL (
      SELECT on_track, responded_at FROM public.pre_joining_pulse_responses pr
      WHERE pr.tenant_id = a.tenant_id AND pr.application_id = a.id
      ORDER BY responded_at DESC LIMIT 1
    ) lp ON true
    WHERE a.tenant_id = ${tenantId}
      AND a.current_stage = 'offer_accepted'
      AND (oc.status IS NULL OR oc.status = 'pre_boarding')
      ${scope}
    ORDER BY o.joining_date ASC
    LIMIT 500
  `;

  const ids = raw.map((r) => r.application_id);
  const signalRows =
    ids.length === 0
      ? []
      : await sql<
          {
            id: string;
            application_id: string;
            signal_type: string;
            quote: string | null;
            created_at: Date | string;
          }[]
        >`
          SELECT id, application_id, signal_type, quote, created_at
          FROM public.candidate_risk_signals
          WHERE tenant_id = ${tenantId} AND status = 'open' AND application_id = ANY(${ids}::uuid[])
          ORDER BY created_at DESC
        `;
  const byApp = new Map<string, JoiningWatchlistRow["openSignals"]>();
  for (const s of signalRows) {
    const type = asSignalType(s.signal_type);
    if (!type) continue;
    const list = byApp.get(s.application_id) ?? [];
    list.push({
      id: s.id,
      type,
      label: RISK_SIGNAL_LABELS[type],
      quote: s.quote,
      createdAt: iso(s.created_at) ?? "",
    });
    byApp.set(s.application_id, list);
  }

  const rows: JoiningWatchlistRow[] = raw.map((r) => ({
    applicationId: r.application_id,
    candidateId: r.candidate_id,
    candidateName: r.candidate_name ?? "—",
    role: r.role,
    businessUnit: r.business_unit,
    recruiterName: r.recruiter_name,
    joiningDate: r.joining_date,
    daysToJoining: daysBetweenIso(today, r.joining_date),
    journeyStatus: r.journey_status ?? "none",
    lastSentAt: iso(r.last_sent_at),
    lastReceivedAt: iso(r.last_received_at),
    lastPulseAnswer: (r.last_pulse_answer as PulseOnTrack | null) ?? null,
    lastPulseAt: iso(r.last_pulse_at),
    openSignals: byApp.get(r.application_id) ?? [],
    missedPulses: Number(r.missed_pulses),
  }));

  const reneged = await sql<
    {
      application_id: string;
      candidate_name: string | null;
      role: string;
      business_unit: string | null;
      joining_date: string | null;
      reason_code: string;
      reason_label: string;
      notes: string | null;
      recorded_at: Date | string;
    }[]
  >`
    SELECT rn.application_id, pe.full_name AS candidate_name, pos.title AS role,
           bu.name AS business_unit, o.joining_date::text AS joining_date,
           rn.reason_code, rn.reason_label, rn.notes, rn.recorded_at
    FROM public.offer_reneges rn
    JOIN public.offers o ON o.tenant_id = rn.tenant_id AND o.id = rn.offer_id
    JOIN public.applications a ON a.tenant_id = rn.tenant_id AND a.id = rn.application_id
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons pe ON pe.tenant_id = c.tenant_id AND pe.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    LEFT JOIN public.business_units bu ON bu.tenant_id = pos.tenant_id AND bu.id = pos.business_unit_id
    WHERE rn.tenant_id = ${tenantId} ${scope}
    ORDER BY rn.recorded_at DESC
    LIMIT 200
  `;

  return {
    rows,
    reneged: reneged.map((r) => ({
      applicationId: r.application_id,
      candidateName: r.candidate_name ?? "—",
      role: r.role,
      businessUnit: r.business_unit,
      joiningDate: r.joining_date,
      reasonCode: r.reason_code,
      reasonLabel: r.reason_label,
      notes: r.notes,
      recordedAt: iso(r.recorded_at) ?? "",
    })),
  };
}

/** Is this application in the recruiter's scope (or does the caller see all)? */
export async function applicationInScope(
  sql: PgSqlClient,
  args: { tenantId: string; applicationId: string; recruiterMembershipId: string | null },
): Promise<boolean> {
  const scope = args.recruiterMembershipId
    ? sql`AND COALESCE(a.assigned_recruiter_membership_id, r.primary_recruiter_id) = ${args.recruiterMembershipId}`
    : sql``;
  const rows = await sql<{ id: string }[]>`
    SELECT a.id FROM public.applications a
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    WHERE a.tenant_id = ${args.tenantId} AND a.id = ${args.applicationId} ${scope}
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function getEngagementTimeline(
  sql: PgSqlClient,
  args: { tenantId: string; applicationId: string },
): Promise<GetEngagementTimelineOutput | null> {
  const { tenantId, applicationId } = args;
  const [head] = await sql<
    {
      candidate_name: string | null;
      role: string;
      current_stage: string;
      joining_date: string | null;
      journey_status: string | null;
      stop_reason: string | null;
    }[]
  >`
    SELECT pe.full_name AS candidate_name, pos.title AS role, a.current_stage::text AS current_stage,
           COALESCE(j.joining_date::text, (
             SELECT o.joining_date::text FROM public.offers o
             WHERE o.tenant_id = a.tenant_id AND o.application_id = a.id
               AND o.status IN ('accepted', 'reneged')
             ORDER BY o.accepted_at DESC NULLS LAST LIMIT 1)) AS joining_date,
           j.status AS journey_status, j.stop_reason
    FROM public.applications a
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons pe ON pe.tenant_id = c.tenant_id AND pe.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    LEFT JOIN public.pre_joining_journeys j ON j.tenant_id = a.tenant_id AND j.application_id = a.id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
    LIMIT 1
  `;
  if (!head) return null;

  const items: EngagementTimelineItem[] = [];

  const tps = await sql<
    {
      id: string;
      step_key: string;
      status: string;
      scheduled_for: Date | string;
      sent_at: Date | string | null;
      carries_pulse: boolean;
      skip_reason: string | null;
      update_title: string | null;
    }[]
  >`
    SELECT tp.id, tp.step_key, tp.status, tp.scheduled_for, tp.sent_at, tp.carries_pulse,
           tp.skip_reason, u.title AS update_title
    FROM public.pre_joining_touchpoints tp
    LEFT JOIN public.pre_joining_company_updates u ON u.id = tp.company_update_id
    WHERE tp.tenant_id = ${tenantId} AND tp.application_id = ${applicationId}
  `;
  for (const t of tps) {
    const step = preJoiningStepKeySchema.safeParse(t.step_key);
    if (!step.success) continue;
    const stepKey = step.data;
    items.push({
      kind: "touchpoint",
      id: t.id,
      at: iso(t.sent_at) ?? iso(t.scheduled_for) ?? "",
      stepKey,
      status: t.status,
      carriesPulse: t.carries_pulse,
      detail: t.update_title ?? t.skip_reason,
    });
  }

  const pulses = await sql<
    {
      id: string;
      on_track: string;
      feeling: number | null;
      comment: string | null;
      responded_at: Date | string;
    }[]
  >`
    SELECT id, on_track, feeling, comment, responded_at FROM public.pre_joining_pulse_responses
    WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
  `;
  for (const p of pulses) {
    items.push({
      kind: "pulse_response",
      id: p.id,
      at: iso(p.responded_at) ?? "",
      onTrack: p.on_track as PulseOnTrack,
      feeling: p.feeling,
      comment: p.comment,
    });
  }

  const msgs = await sql<
    {
      id: string;
      from_email: string;
      subject: string | null;
      body_text: string | null;
      received_at: Date | string;
    }[]
  >`
    SELECT id, from_email, subject, body_text, received_at FROM public.candidate_inbound_messages
    WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
  `;
  for (const m of msgs) {
    items.push({
      kind: "inbound_message",
      id: m.id,
      at: iso(m.received_at) ?? "",
      fromEmail: m.from_email,
      subject: m.subject,
      bodyText: m.body_text,
    });
  }

  const sigs = await sql<
    {
      id: string;
      signal_type: string;
      source: string;
      quote: string | null;
      status: string;
      created_at: Date | string;
    }[]
  >`
    SELECT id, signal_type, source, quote, status, created_at FROM public.candidate_risk_signals
    WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
  `;
  for (const s of sigs) {
    const type = asSignalType(s.signal_type);
    if (!type) continue;
    items.push({
      kind: "signal",
      id: s.id,
      at: iso(s.created_at) ?? "",
      type,
      label: RISK_SIGNAL_LABELS[type],
      source: s.source === "pulse_response" ? "pulse_response" : "inbound_email",
      quote: s.quote,
      status: s.status === "acknowledged" ? "acknowledged" : "open",
    });
  }

  // PC-18 — "Welcome guide viewed": one entry per guide version opened.
  for (const v of await listWelcomeGuideViews(sql, tenantId, applicationId)) {
    items.push({
      kind: "welcome_guide_viewed",
      id: v.guideId,
      at: v.firstViewedAt,
      guideVersion: v.version,
      sectionsViewed: v.sections,
    });
  }

  const reneges = await sql<
    { id: string; reason_label: string; notes: string | null; recorded_at: Date | string }[]
  >`
    SELECT id, reason_label, notes, recorded_at FROM public.offer_reneges
    WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
  `;
  for (const r of reneges) {
    items.push({
      kind: "renege",
      id: r.id,
      at: iso(r.recorded_at) ?? "",
      reasonLabel: r.reason_label,
      notes: r.notes,
    });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return {
    applicationId,
    candidateName: head.candidate_name ?? "—",
    role: head.role,
    joiningDate: head.joining_date,
    currentStage: head.current_stage,
    journeyStatus: head.journey_status ?? "none",
    journeyStopReason: head.stop_reason,
    items,
  };
}

export async function acknowledgeRiskSignal(
  sql: PgSqlClient,
  args: { tenantId: string; signalId: string; membershipId: string | null },
): Promise<{ applicationId: string } | null> {
  const rows = await sql<{ application_id: string }[]>`
    UPDATE public.candidate_risk_signals
    SET status = 'acknowledged', acknowledged_at = now(),
        acknowledged_by_membership_id = ${args.membershipId}
    WHERE tenant_id = ${args.tenantId} AND id = ${args.signalId} AND status = 'open'
    RETURNING application_id
  `;
  return rows[0] ? { applicationId: rows[0].application_id } : null;
}

export type RecordRenegeOutcome =
  | { ok: true; renegeId: string; offerId: string }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST"; message: string };

/**
 * PC-17 — accepted offer → reneged. Single transaction:
 *   offer accepted → 'reneged' (guarded: only an 'accepted' row flips),
 *   offer_reneges row (reason as configured + notes),
 *   application offer_accepted → withdrawn (+ state transition, withdrawn_reason),
 *   onboarding case pre_boarding → cancelled (no hire is coming),
 *   pre-joining journey stopped (scheduled touchpoints cancelled).
 * The Workday pre-hire already queued on accept is NOT touched (out of scope).
 */
export async function recordRenege(
  sql: PgSqlClient,
  args: { tenantId: string; membershipId: string | null; input: RecordRenegeInput; log: Logger },
): Promise<RecordRenegeOutcome> {
  const { tenantId, input } = args;
  const settings = await loadPreJoiningSettings(sql, tenantId);
  const reason = settings.renegeReasons.find((r) => r.code === input.reasonCode);
  if (!reason) return { ok: false, code: "BAD_REQUEST", message: "Unknown renege reason" };

  const [app] = await sql<{ current_stage: string; offer_id: string | null }[]>`
    SELECT a.current_stage::text AS current_stage,
           (SELECT o.id FROM public.offers o
             WHERE o.tenant_id = a.tenant_id AND o.application_id = a.id AND o.status = 'accepted'
             ORDER BY o.accepted_at DESC NULLS LAST LIMIT 1) AS offer_id
    FROM public.applications a
    WHERE a.tenant_id = ${tenantId} AND a.id = ${input.applicationId}
    LIMIT 1
  `;
  if (!app) return { ok: false, code: "NOT_FOUND", message: "Application not found" };
  if (app.current_stage !== "offer_accepted" || !app.offer_id) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "Only an application with an accepted offer can be marked as reneged",
    };
  }
  const offerId = app.offer_id;
  const notes = input.notes?.trim() ? input.notes.trim() : null;

  const renegeId = await sql.begin(async (tx) => {
    const flipped = await tx<{ id: string }[]>`
      UPDATE public.offers SET status = 'reneged', updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${offerId} AND status = 'accepted'
      RETURNING id
    `;
    if (flipped.length === 0) return null;
    const [rn] = await tx<{ id: string }[]>`
      INSERT INTO public.offer_reneges
        (tenant_id, application_id, offer_id, reason_code, reason_label, notes, recorded_by_membership_id)
      VALUES (${tenantId}, ${input.applicationId}, ${offerId}, ${reason.code}, ${reason.label},
              ${notes}, ${args.membershipId})
      RETURNING id
    `;
    await tx`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, actor_membership_id, reason, metadata)
      VALUES (${tenantId}, ${input.applicationId}, 'offer_accepted', 'withdrawn', ${args.membershipId},
              ${`reneged after accepting: ${reason.label}`},
              ${JSON.stringify({ renege: true, reasonCode: reason.code, offerId })}::jsonb)
    `;
    await tx`
      UPDATE public.applications
      SET current_stage = 'withdrawn', stage_entered_at = now(),
          withdrawn_reason = ${`Reneged: ${reason.label}`}
      WHERE tenant_id = ${tenantId} AND id = ${input.applicationId}
    `;
    await tx`
      UPDATE public.onboarding_cases SET status = 'cancelled', updated_at = now()
      WHERE tenant_id = ${tenantId} AND application_id = ${input.applicationId}
        AND status = 'pre_boarding'
    `;
    await stopPreJoiningJourney(tx as unknown as PgSqlClient, {
      tenantId,
      applicationId: input.applicationId,
      reason: "reneged",
    });
    return rn?.id ?? null;
  });
  if (!renegeId) {
    return { ok: false, code: "CONFLICT", message: "The offer is no longer in the accepted state" };
  }
  args.log.info(
    { tenant_id: tenantId, application_id: input.applicationId, reason: reason.code },
    "pre_joining.renege_recorded",
  );
  return { ok: true, renegeId, offerId };
}
