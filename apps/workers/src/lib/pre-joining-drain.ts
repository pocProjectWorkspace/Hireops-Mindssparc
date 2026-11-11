/**
 * PC-14 — pre-joining touchpoint drain.
 *
 * Sends due `pre_joining_touchpoints` rows. "Send" = enqueue ONE
 * notification_outbox row (the existing dispatcher delivers the email, and
 * the same row is what the candidate portal's Notifications feed shows), in
 * the same transaction that marks the touchpoint 'sent'. The outbox dedup
 * key is per touchpoint (+ recipient), so a touchpoint can never produce two
 * emails even if the claim is replayed.
 *
 * Per claimed row, in order:
 *   1. Journey no longer active → touchpoint 'cancelled'.
 *   2. Application left offer_accepted → stop the journey (reneged when an
 *      offer_reneges row exists, else withdrawn).
 *   3. Onboarding case at day_zero / in_progress / completed → stop (joined).
 *   4. Joining date today or past (tenant time zone) → complete the journey.
 *   5. Engagement switched off, or this step switched off → 'skipped'.
 *   6. More than STALE_AFTER late (worker was down) → 'skipped' (stale) —
 *      a "two weeks to go" email must not arrive with three days to go.
 *   7. Inside quiet hours → re-parked to the end of the quiet window, the
 *      attempt is refunded.
 *   8. company_update: the next active update not yet sent on this journey;
 *      none left → 'skipped'. welcome_guide (PC-18): no published guide for
 *      the candidate's business unit (own → ancestor → organisation) →
 *      'skipped' (no_welcome_guide); otherwise the email links to the
 *      candidate-portal guide page.
 *   9. Pulse-carrying steps get a signed check-in link (action
 *      candidate.pre_joining_pulse, subject = touchpoint id, expiring the day
 *      after joining); its SHA-256 is stored on the touchpoint.
 *  10. Insert the outbox row + mark 'sent' — one transaction.
 *
 * Claim shape follows ai-interview-evidence-drain: UPDATE … WHERE id IN
 * (SELECT … FOR UPDATE SKIP LOCKED) with a lease; an expired 'processing'
 * lease below the cap is claimable again; per-row try/catch.
 */

import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { hashToken, signLink, type TemplateKey } from "@hireops/notifications";
import {
  applyQuietHours,
  buildReplyToAddress,
  isQuietHour,
  isStepEnabled,
  localParts,
  daysBetweenIso,
  addDaysIso,
  zonedInstant,
  preJoiningStepKeySchema,
  type PreJoiningStepKey,
} from "@hireops/api-types";
import {
  caseStatusMeansJoined,
  formatJoiningDate,
  loadPreJoiningSettings,
  PULSE_LINK_ACTION,
  portalBaseUrl,
  resolveWelcomeGuideForApplication,
  startPreJoiningJourney,
  stopPreJoiningJourney,
} from "@hireops/api/pre-joining";
import { tenantGateSql } from "./tenant-gate";

export const PRE_JOINING_ATTEMPT_CAP = 5;
export const PRE_JOINING_LEASE_MS = 5 * 60_000;
/** A touchpoint more than this late is skipped rather than sent. */
export const PRE_JOINING_STALE_AFTER_MS = 3 * 86_400_000;
const DEFAULT_BATCH = 20;

const TEMPLATE_BY_STEP: Record<PreJoiningStepKey, TemplateKey> = {
  welcome: "candidate.pre_joining_welcome",
  welcome_guide: "candidate.pre_joining_welcome_guide",
  pulse: "candidate.pre_joining_pulse",
  company_update: "candidate.pre_joining_company_update",
  two_weeks_to_go: "candidate.pre_joining_two_weeks",
  one_week_to_go: "candidate.pre_joining_one_week",
};

export interface PreJoiningDrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
  /** Test hook — defaults to the wall clock. */
  now?: () => Date;
}

export interface PreJoiningDrainResult {
  claimed: number;
  sent: number;
  skipped: number;
  cancelled: number;
  deferred: number;
  retried: number;
  failed: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  journey_id: string;
  application_id: string;
  step_key: string;
  sequence: number;
  scheduled_for: Date | string;
  carries_pulse: boolean;
  attempt_count: number;
}

type Outcome = "sent" | "skipped" | "cancelled" | "deferred";

export async function drainPreJoiningTouchpointsOnce(
  opts: PreJoiningDrainOpts,
): Promise<PreJoiningDrainResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const workerId = opts.workerId ?? `pre-joining-${randomUUID().slice(0, 8)}`;
  const now = opts.now ?? (() => new Date());
  const log = opts.log;
  const nowIso = now().toISOString();

  // Retire 'processing' rows whose lease expired AT the cap.
  await poolSql`
    UPDATE public.pre_joining_touchpoints
    SET status = 'failed', lease_expires_at = NULL, updated_at = now(),
        last_error = COALESCE(last_error, 'lease expired at attempt cap')
    WHERE status = 'processing' AND lease_expires_at < ${nowIso}::timestamptz
      AND attempt_count >= ${PRE_JOINING_ATTEMPT_CAP}
  `;

  const rows = await poolSql<ClaimedRow[]>`
    UPDATE public.pre_joining_touchpoints
    SET status = 'processing',
        attempt_count = attempt_count + 1,
        lease_expires_at = ${nowIso}::timestamptz + (${PRE_JOINING_LEASE_MS}::int * interval '1 millisecond'),
        updated_at = now()
    WHERE id IN (
      SELECT id FROM public.pre_joining_touchpoints
      WHERE ((status = 'scheduled' AND scheduled_for <= ${nowIso}::timestamptz)
         OR (status = 'processing' AND lease_expires_at < ${nowIso}::timestamptz
             AND attempt_count < ${PRE_JOINING_ATTEMPT_CAP}))
      -- C1-F10: skip rows of non-active tenants (D3) + module off (D4).
        ${tenantGateSql("pre_joining_touchpoints", "pre_joining_engagement")}
      ORDER BY scheduled_for
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, journey_id, application_id, step_key, sequence,
              scheduled_for, carries_pulse, attempt_count
  `;

  const result: PreJoiningDrainResult = {
    claimed: rows.length,
    sent: 0,
    skipped: 0,
    cancelled: 0,
    deferred: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of rows) {
    const child = log.child({
      touchpoint_id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      step_key: row.step_key,
      attempt: row.attempt_count,
      worker_id: workerId,
    });
    try {
      const outcome = await processRow(row, now(), child);
      result[outcome] += 1;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (row.attempt_count >= PRE_JOINING_ATTEMPT_CAP) {
        await poolSql`
          UPDATE public.pre_joining_touchpoints
          SET status = 'failed', last_error = ${errMsg}, lease_expires_at = NULL, updated_at = now()
          WHERE id = ${row.id}
        `;
        result.failed += 1;
        child.error({ err: errMsg }, "pre_joining.touchpoint_failed");
      } else {
        // Back off: re-park 2^n minutes out.
        const backoffMs = 60_000 * 2 ** (row.attempt_count - 1);
        await poolSql`
          UPDATE public.pre_joining_touchpoints
          SET status = 'scheduled', last_error = ${errMsg}, lease_expires_at = NULL,
              scheduled_for = now() + (${backoffMs}::int * interval '1 millisecond'),
              updated_at = now()
          WHERE id = ${row.id}
        `;
        result.retried += 1;
        child.warn({ err: errMsg }, "pre_joining.touchpoint_retry");
      }
    }
  }
  return result;
}

async function finish(
  id: string,
  status: "skipped" | "cancelled",
  reason: string,
): Promise<"skipped" | "cancelled"> {
  await poolSql`
    UPDATE public.pre_joining_touchpoints
    SET status = ${status}, skip_reason = ${reason}, lease_expires_at = NULL, updated_at = now()
    WHERE id = ${id}
  `;
  return status;
}

interface ContextRow {
  journey_status: string;
  joining_date: string;
  reply_token: string;
  current_stage: string;
  case_status: string | null;
  reneged: boolean;
  candidate_id: string;
  candidate_name: string | null;
  candidate_email: string | null;
  position_title: string;
  company_name: string;
}

async function processRow(row: ClaimedRow, now: Date, log: Logger): Promise<Outcome> {
  const stepParse = preJoiningStepKeySchema.safeParse(row.step_key);
  if (!stepParse.success) return finish(row.id, "skipped", "unknown_step");
  const step = stepParse.data;

  const [c] = await poolSql<ContextRow[]>`
    SELECT
      j.status AS journey_status,
      j.joining_date::text AS joining_date,
      j.reply_token,
      a.current_stage::text AS current_stage,
      oc.status AS case_status,
      EXISTS (
        SELECT 1 FROM public.offer_reneges r
        WHERE r.tenant_id = a.tenant_id AND r.application_id = a.id
      ) AS reneged,
      c.id AS candidate_id,
      p.full_name AS candidate_name,
      p.email_primary AS candidate_email,
      pos.title AS position_title,
      t.display_name AS company_name
    FROM public.pre_joining_journeys j
    JOIN public.applications a ON a.tenant_id = j.tenant_id AND a.id = j.application_id
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    JOIN public.tenants t ON t.id = j.tenant_id
    LEFT JOIN public.onboarding_cases oc
      ON oc.tenant_id = a.tenant_id AND oc.application_id = a.id
    WHERE j.tenant_id = ${row.tenant_id} AND j.id = ${row.journey_id}
    LIMIT 1
  `;
  if (!c) return finish(row.id, "cancelled", "journey_missing");
  if (c.journey_status !== "active")
    return finish(row.id, "cancelled", `journey_${c.journey_status}`);

  const ids = { tenantId: row.tenant_id, applicationId: row.application_id };
  if (c.current_stage !== "offer_accepted") {
    const reason = c.reneged ? "reneged" : "withdrawn";
    await stopPreJoiningJourney(poolSql, { ...ids, reason });
    log.info({ reason }, "pre_joining.journey_stopped");
    return finish(row.id, "cancelled", reason);
  }
  if (caseStatusMeansJoined(c.case_status)) {
    await stopPreJoiningJourney(poolSql, { ...ids, reason: "joined" });
    return finish(row.id, "cancelled", "joined");
  }

  const settings = await loadPreJoiningSettings(poolSql, row.tenant_id);
  const tz = settings.quietHours.timezone;
  const today = localParts(now, tz).date;
  if (daysBetweenIso(today, c.joining_date) <= 0) {
    await stopPreJoiningJourney(poolSql, { ...ids, reason: "joining_date_passed" });
    return finish(row.id, "cancelled", "joining_date_passed");
  }
  if (!settings.enabled) return finish(row.id, "skipped", "engagement_disabled");
  if (!isStepEnabled(settings, step)) return finish(row.id, "skipped", "step_disabled");
  if (now.getTime() - new Date(row.scheduled_for).getTime() > PRE_JOINING_STALE_AFTER_MS) {
    return finish(row.id, "skipped", "stale");
  }
  if (!c.candidate_email) return finish(row.id, "skipped", "no_candidate_email");

  if (isQuietHour(localParts(now, tz).hour, settings.quietHours)) {
    const next = applyQuietHours(now, settings.quietHours);
    await poolSql`
      UPDATE public.pre_joining_touchpoints
      SET status = 'scheduled', scheduled_for = ${next.toISOString()}::timestamptz,
          attempt_count = GREATEST(attempt_count - 1, 0), lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${row.id}
    `;
    return "deferred";
  }

  let update: {
    id: string;
    title: string;
    body: string;
    link_url: string | null;
    video_url: string | null;
  } | null = null;
  if (step === "company_update") {
    const [u] = await poolSql<
      {
        id: string;
        title: string;
        body: string;
        link_url: string | null;
        video_url: string | null;
      }[]
    >`
      SELECT u.id, u.title, u.body, u.link_url, u.video_url
      FROM public.pre_joining_company_updates u
      WHERE u.tenant_id = ${row.tenant_id} AND u.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM public.pre_joining_touchpoints tp
          WHERE tp.tenant_id = u.tenant_id AND tp.journey_id = ${row.journey_id}
            AND tp.company_update_id = u.id AND tp.status = 'sent'
        )
      ORDER BY u.sort_order, u.created_at
      LIMIT 1
    `;
    if (!u) return finish(row.id, "skipped", "no_company_update");
    update = u;
  }

  let guideUrl: string | null = null;
  if (step === "welcome_guide") {
    const guide = await resolveWelcomeGuideForApplication(
      poolSql,
      row.tenant_id,
      row.application_id,
    );
    if (!guide) return finish(row.id, "skipped", "no_welcome_guide");
    guideUrl = `${portalBaseUrl()}/candidate/welcome`;
  }

  let pulseUrl: string | null = null;
  let pulseTokenHash: string | null = null;
  if (row.carries_pulse) {
    // Valid until the end of the day after joining (UTC instant of that local midnight).
    const expiresAt = zonedInstant(addDaysIso(c.joining_date, 2), 0, tz);
    const token = signLink({ action: PULSE_LINK_ACTION, subjectId: row.id, expiresAt });
    pulseTokenHash = hashToken(token);
    pulseUrl = `${portalBaseUrl()}/pulse/${token}`;
  }

  const inboundDomain = process.env.PRE_JOINING_REPLY_DOMAIN?.trim();
  const templateData: Record<string, unknown> = {
    candidateName: c.candidate_name ?? "there",
    companyName: c.company_name,
    positionTitle: c.position_title,
    joiningDate: formatJoiningDate(c.joining_date),
    pulseUrl,
    ...(guideUrl ? { guideUrl } : {}),
    ...(update
      ? {
          updateTitle: update.title,
          updateBody: update.body,
          updateLinkUrl: update.link_url,
          updateVideoUrl: update.video_url,
        }
      : {}),
    ...(step === "one_week_to_go" ? { firstDayInfo: settings.firstDayInfo } : {}),
    ...(inboundDomain ? { replyTo: buildReplyToAddress(c.reply_token, inboundDomain) } : {}),
    ...(settings.senderName ? { senderName: settings.senderName } : {}),
  };
  const dedupKey = `pre_joining:${row.id}:${c.candidate_id}`;
  const templateKey = TEMPLATE_BY_STEP[step];
  const email = c.candidate_email;

  await poolSql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO public.notification_outbox
        (tenant_id, recipient_type, recipient_email, recipient_candidate_id,
         template_key, template_data, dedup_key, priority)
      VALUES (${row.tenant_id}, 'candidate', ${email}, ${c.candidate_id},
              ${templateKey}, ${JSON.stringify(templateData)}::jsonb, ${dedupKey}, 6)
      ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
      RETURNING id
    `;
    let outboxId = inserted[0]?.id ?? null;
    if (!outboxId) {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM public.notification_outbox
        WHERE tenant_id = ${row.tenant_id} AND dedup_key = ${dedupKey} LIMIT 1
      `;
      outboxId = existing?.id ?? null;
      // Already enqueued by an earlier (replayed) claim: keep its link, not a new one.
      pulseTokenHash = null;
    }
    await tx`
      UPDATE public.pre_joining_touchpoints
      SET status = 'sent', sent_at = now(), lease_expires_at = NULL, last_error = NULL,
          notification_outbox_id = ${outboxId},
          company_update_id = ${update?.id ?? null},
          pulse_token_hash = COALESCE(${pulseTokenHash}, pulse_token_hash),
          updated_at = now()
      WHERE id = ${row.id}
    `;
  });
  log.info({ template_key: templateKey }, "pre_joining.touchpoint_sent");
  return "sent";
}

/**
 * Hourly scan (scheduled job): for every tenant with engagement ENABLED,
 * start journeys for accepted-not-joined applications that have none
 * (backfill + a safety net for an accept whose best-effort start failed),
 * and complete active journeys whose joining date has passed.
 */
export async function preJoiningJourneyScan(log: Logger): Promise<void> {
  const tenants = await poolSql<{ id: string; settings: Record<string, unknown> | null }[]>`
    SELECT id, settings FROM public.tenants
    WHERE COALESCE((settings->'preJoiningEngagement'->>'enabled')::boolean, false) = true
      -- C1-F10: active tenants (D3) with the module entitled (D4) only.
      AND status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM public.tenant_modules m
         WHERE m.tenant_id = tenants.id AND m.module_key = 'pre_joining_engagement'
           AND m.enabled = false
      )
  `;
  let started = 0;
  for (const t of tenants) {
    const settings = await loadPreJoiningSettings(poolSql, t.id);
    if (!settings.enabled) continue;
    const candidates = await poolSql<{ id: string }[]>`
      SELECT a.id FROM public.applications a
      WHERE a.tenant_id = ${t.id} AND a.current_stage = 'offer_accepted'
        AND NOT EXISTS (
          SELECT 1 FROM public.pre_joining_journeys j
          WHERE j.tenant_id = a.tenant_id AND j.application_id = a.id
        )
      LIMIT 500
    `;
    for (const a of candidates) {
      try {
        const r = await startPreJoiningJourney(poolSql, {
          tenantId: t.id,
          applicationId: a.id,
          log,
          settings,
        });
        if (r.created) started += 1;
      } catch (err) {
        log.warn({ err, tenant_id: t.id, application_id: a.id }, "pre_joining.scan_start_failed");
      }
    }
    const today = localParts(new Date(), settings.quietHours.timezone).date;
    const due = await poolSql<{ application_id: string }[]>`
      SELECT application_id FROM public.pre_joining_journeys
      WHERE tenant_id = ${t.id} AND status = 'active' AND joining_date <= ${today}::date
    `;
    for (const j of due) {
      await stopPreJoiningJourney(poolSql, {
        tenantId: t.id,
        applicationId: j.application_id,
        reason: "joining_date_passed",
      });
    }
  }
  if (started > 0) log.info({ started }, "pre_joining.scan_started_journeys");
}
