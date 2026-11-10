/**
 * PC-14 — pre-joining journey lifecycle (server side, shared by the api and
 * the worker).
 *
 * One journey per accepted application (UNIQUE tenant_id, application_id). A
 * journey is a plan of touchpoints from accept to the joining date
 * (planPreJoiningTouchpoints, pure, in @hireops/api-types) persisted as
 * `pre_joining_touchpoints` rows the worker drain sends when due.
 *
 * Entry points:
 *   - startPreJoiningJourney — idempotent; called (best-effort) from the
 *     offer-accept side-effect sequence, from the admin "start for existing
 *     accepted candidates" action, and by the worker's hourly backfill scan
 *     (so a tenant that turns the feature on picks up its accepted-not-joined
 *     candidates without anyone pressing a button).
 *   - stopPreJoiningJourney — on join / renege / withdraw; cancels every
 *     still-scheduled touchpoint.
 *   - raiseRiskSignal — record a named signal (the candidate's words) and,
 *     per the tenant's settings, alert the recruiter (in-app = the open
 *     signal on the watchlist; email = recruiter.joining_risk_signal).
 *
 * Raw postgres.js with an EXPLICIT tenant_id on every statement — the
 * offers.ts / onboarding-case.ts discipline. Dates go in as ISO strings with
 * explicit casts (reality #113).
 *
 * FACTS, NOT SCORES — nothing here computes or stores a risk score.
 */

import { randomBytes } from "node:crypto";
import { sql as poolSql, db as poolDb } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { enqueueNotification } from "@hireops/notifications";
import {
  RISK_SIGNAL_LABELS,
  planPreJoiningTouchpoints,
  resolvePreJoiningEngagementSettings,
  signalPolicy,
  type PreJoiningEngagementSettings,
  type RiskSignalSource,
  type RiskSignalType,
} from "@hireops/api-types";

/** postgres.js tagged-template client (same shape as ctx.sql / poolSql). */
type PgSqlClient = typeof poolSql;

export type JourneyStopReason =
  | "joined"
  | "reneged"
  | "withdrawn"
  | "offer_not_accepted"
  | "joining_date_passed";

export async function loadPreJoiningSettings(
  sql: PgSqlClient,
  tenantId: string,
): Promise<PreJoiningEngagementSettings> {
  const rows = await sql<{ settings: Record<string, unknown> | null }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  return resolvePreJoiningEngagementSettings(rows[0]?.settings?.preJoiningEngagement);
}

export function newReplyToken(): string {
  return randomBytes(16).toString("hex");
}

/** Has this onboarding case status reached the start date (the hire joined)? */
export function caseStatusMeansJoined(status: string | null | undefined): boolean {
  return status === "day_zero" || status === "in_progress" || status === "completed";
}

export interface StartJourneyResult {
  journeyId: string | null;
  created: boolean;
  planned: number;
  /** Why nothing was started (disabled, not accepted, joined, …). */
  skipped?: string;
}

/**
 * Start (or no-op on) the journey for one application. Idempotent: a second
 * call finds the existing journey and returns created=false without adding
 * touchpoints. Never throws for "not eligible" — it says why in `skipped`.
 */
export async function startPreJoiningJourney(
  sql: PgSqlClient,
  args: {
    tenantId: string;
    applicationId: string;
    log: Logger;
    now?: Date;
    /** Pre-resolved settings (the batch scan passes them; saves a read per row). */
    settings?: PreJoiningEngagementSettings;
  },
): Promise<StartJourneyResult> {
  const { tenantId, applicationId, log } = args;
  const now = args.now ?? new Date();
  const settings = args.settings ?? (await loadPreJoiningSettings(sql, tenantId));
  if (!settings.enabled)
    return { journeyId: null, created: false, planned: 0, skipped: "disabled" };

  const [row] = await sql<
    {
      current_stage: string;
      candidate_id: string;
      offer_id: string | null;
      joining_date: string | null;
      accepted_at: Date | string | null;
      case_status: string | null;
      existing_journey: string | null;
    }[]
  >`
    SELECT
      a.current_stage::text AS current_stage,
      a.candidate_id,
      o.id AS offer_id,
      o.joining_date::text AS joining_date,
      o.accepted_at,
      oc.status AS case_status,
      j.id AS existing_journey
    FROM public.applications a
    LEFT JOIN LATERAL (
      SELECT id, joining_date, accepted_at FROM public.offers
      WHERE tenant_id = ${tenantId} AND application_id = a.id AND status = 'accepted'
      ORDER BY accepted_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    ) o ON true
    LEFT JOIN public.onboarding_cases oc
      ON oc.tenant_id = a.tenant_id AND oc.application_id = a.id
    LEFT JOIN public.pre_joining_journeys j
      ON j.tenant_id = a.tenant_id AND j.application_id = a.id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
    LIMIT 1
  `;
  if (!row) return { journeyId: null, created: false, planned: 0, skipped: "not_found" };
  if (row.existing_journey) {
    return { journeyId: row.existing_journey, created: false, planned: 0, skipped: "exists" };
  }
  if (row.current_stage !== "offer_accepted" || !row.offer_id || !row.joining_date) {
    return { journeyId: null, created: false, planned: 0, skipped: "not_accepted" };
  }
  if (caseStatusMeansJoined(row.case_status) || row.case_status === "cancelled") {
    return { journeyId: null, created: false, planned: 0, skipped: "joined_or_cancelled" };
  }

  const acceptedAt = row.accepted_at ? new Date(row.accepted_at) : now;
  const plan = planPreJoiningTouchpoints({
    joiningDate: row.joining_date,
    acceptedAt,
    now,
    settings,
  });
  if (plan.length === 0) {
    return { journeyId: null, created: false, planned: 0, skipped: "nothing_to_schedule" };
  }

  const result = await sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO public.pre_joining_journeys
        (tenant_id, application_id, candidate_id, offer_id, joining_date, reply_token, started_at)
      VALUES (${tenantId}, ${applicationId}, ${row.candidate_id}, ${row.offer_id},
              ${row.joining_date}::date, ${newReplyToken()}, ${now.toISOString()}::timestamptz)
      ON CONFLICT (tenant_id, application_id) DO NOTHING
      RETURNING id
    `;
    const journeyId = inserted[0]?.id;
    if (!journeyId) return null; // lost a concurrent race — the winner planned it
    for (const p of plan) {
      await tx`
        INSERT INTO public.pre_joining_touchpoints
          (tenant_id, journey_id, application_id, step_key, sequence, scheduled_for, carries_pulse)
        VALUES (${tenantId}, ${journeyId}, ${applicationId}, ${p.stepKey}, ${p.sequence},
                ${p.scheduledFor.toISOString()}::timestamptz, ${p.carriesPulse})
        ON CONFLICT (tenant_id, journey_id, step_key, sequence) DO NOTHING
      `;
    }
    return journeyId;
  });

  if (!result) {
    const [j] = await sql<{ id: string }[]>`
      SELECT id FROM public.pre_joining_journeys
      WHERE tenant_id = ${tenantId} AND application_id = ${applicationId} LIMIT 1
    `;
    return { journeyId: j?.id ?? null, created: false, planned: 0, skipped: "exists" };
  }
  log.info(
    {
      tenant_id: tenantId,
      application_id: applicationId,
      journey_id: result,
      planned: plan.length,
    },
    "pre_joining.journey_started",
  );
  return { journeyId: result, created: true, planned: plan.length };
}

/**
 * Stop an active journey and cancel its still-scheduled touchpoints. Returns
 * true when a journey was actually stopped. `completed` is used for the
 * natural end (joining date reached); everything else is `stopped`.
 */
export async function stopPreJoiningJourney(
  sql: PgSqlClient,
  args: { tenantId: string; applicationId: string; reason: JourneyStopReason },
): Promise<boolean> {
  const status =
    args.reason === "joined" || args.reason === "joining_date_passed" ? "completed" : "stopped";
  const stopped = await sql<{ id: string }[]>`
    UPDATE public.pre_joining_journeys
    SET status = ${status}, stop_reason = ${args.reason}, stopped_at = now(), updated_at = now()
    WHERE tenant_id = ${args.tenantId} AND application_id = ${args.applicationId}
      AND status = 'active'
    RETURNING id
  `;
  const journeyId = stopped[0]?.id;
  if (!journeyId) return false;
  await sql`
    UPDATE public.pre_joining_touchpoints
    SET status = 'cancelled', skip_reason = ${args.reason}, lease_expires_at = NULL,
        updated_at = now()
    WHERE tenant_id = ${args.tenantId} AND journey_id = ${journeyId} AND status = 'scheduled'
  `;
  return true;
}

// ─────────────────────────── signals + alerts ───────────────────────────

export interface RecruiterContact {
  membershipId: string;
  email: string;
  name: string;
}

/**
 * The application's recruiter: the assigned recruiter when set, else the
 * requisition's primary recruiter.
 */
export async function resolveApplicationRecruiter(
  sql: PgSqlClient,
  tenantId: string,
  applicationId: string,
): Promise<RecruiterContact | null> {
  const [row] = await sql<{ membership_id: string; email: string | null; name: string | null }[]>`
    SELECT tum.id AS membership_id, au.email, COALESCE(u.display_name, au.email) AS name
    FROM public.applications a
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.tenant_user_memberships tum
      ON tum.tenant_id = a.tenant_id
     AND tum.id = COALESCE(a.assigned_recruiter_membership_id, r.primary_recruiter_id)
    LEFT JOIN public.users u ON u.id = tum.user_id
    LEFT JOIN auth.users au ON au.id = tum.user_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
    LIMIT 1
  `;
  if (!row || !row.email) return null;
  return { membershipId: row.membership_id, email: row.email, name: row.name ?? row.email };
}

export function portalBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3003").replace(/\/+$/, "");
}

export function formatJoiningDate(date: string | null): string {
  if (!date) return "";
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface RaiseSignalArgs {
  tenantId: string;
  applicationId: string;
  journeyId: string | null;
  type: RiskSignalType;
  source: RiskSignalSource;
  quote: string | null;
  inboundMessageId?: string | null;
  pulseResponseId?: string | null;
  settings: PreJoiningEngagementSettings;
  log: Logger;
}

/**
 * Record one signal (if the tenant records this type) and alert the
 * recruiter (if the tenant alerts on it). Returns the signal id, or null when
 * the type is switched off. The email is deduped per signal id; an email
 * failure is logged and never unwinds the stored signal.
 */
export async function raiseRiskSignal(
  sql: PgSqlClient,
  args: RaiseSignalArgs,
): Promise<{ signalId: string | null; alerted: boolean }> {
  const policy = signalPolicy(args.settings, args.type);
  if (!policy.record) return { signalId: null, alerted: false };

  const [sig] = await sql<{ id: string }[]>`
    INSERT INTO public.candidate_risk_signals
      (tenant_id, application_id, journey_id, signal_type, source, quote,
       inbound_message_id, pulse_response_id)
    VALUES (${args.tenantId}, ${args.applicationId}, ${args.journeyId}, ${args.type},
            ${args.source}, ${args.quote}, ${args.inboundMessageId ?? null},
            ${args.pulseResponseId ?? null})
    RETURNING id
  `;
  const signalId = sig?.id ?? null;
  if (!signalId || !policy.alert) return { signalId, alerted: false };

  try {
    const recruiter = await resolveApplicationRecruiter(sql, args.tenantId, args.applicationId);
    if (!recruiter) {
      args.log.warn({ application_id: args.applicationId }, "pre_joining.signal_no_recruiter");
      return { signalId, alerted: false };
    }
    const [ctx] = await sql<
      { candidate_name: string; position_title: string; joining_date: string | null }[]
    >`
      SELECT p.full_name AS candidate_name, pos.title AS position_title,
             (SELECT j.joining_date::text FROM public.pre_joining_journeys j
               WHERE j.tenant_id = a.tenant_id AND j.application_id = a.id) AS joining_date
      FROM public.applications a
      JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
      JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
      JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
      JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
      WHERE a.tenant_id = ${args.tenantId} AND a.id = ${args.applicationId}
      LIMIT 1
    `;
    await enqueueNotification(poolDb, {
      tenantId: args.tenantId,
      recipientType: "recruiter",
      recipientEmail: recruiter.email,
      recipientMembershipId: recruiter.membershipId,
      templateKey: "recruiter.joining_risk_signal",
      templateData: {
        recruiterName: recruiter.name,
        candidateName: ctx?.candidate_name ?? "A candidate",
        positionTitle: ctx?.position_title ?? "",
        joiningDate: formatJoiningDate(ctx?.joining_date ?? null),
        signalLabel: RISK_SIGNAL_LABELS[args.type],
        sourceLabel:
          args.source === "inbound_email"
            ? "Reply to an engagement email"
            : "Pulse check-in answer",
        quote: args.quote,
        timelineUrl: `${portalBaseUrl()}/joining-watchlist/${args.applicationId}`,
      },
      // One email per signal, per recipient (outbox dedup trap — the key must
      // carry the recipient).
      dedupKey: `joining_risk_signal:${signalId}:${recruiter.membershipId}`,
      priority: 3,
    });
    await sql`
      UPDATE public.candidate_risk_signals SET alerted_at = now()
      WHERE tenant_id = ${args.tenantId} AND id = ${signalId}
    `;
    return { signalId, alerted: true };
  } catch (err) {
    args.log.warn({ err, signal_id: signalId }, "pre_joining.signal_alert_failed");
    return { signalId, alerted: false };
  }
}
