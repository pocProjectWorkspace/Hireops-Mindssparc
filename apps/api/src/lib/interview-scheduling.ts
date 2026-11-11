/**
 * PC-8 / PC-9 / PC-10 — in-app interview scheduling.
 *
 * Availability lives inside HireOps (no external calendar): panellists declare
 * weekly windows and blocked ranges, the slot engine in @hireops/api-types
 * intersects them, and the candidate picks from what is offered.
 *
 * WHY RAW SQL ON THE SERVICE-ROLE POOL. The same logic has to run from three
 * places that do not share a handle: tRPC procedures (ctx.sql), the
 * UNAUTHENTICATED pick-a-slot route (only poolSql — the signed link is the
 * authorisation), and the agent worker's propose_calendar_slots port. So —
 * exactly like ./interview-recording-consent.ts — every statement here carries
 * an EXPLICIT tenant_id predicate; there is no RLS backstop on this path.
 * Callers that act for a signed-in user pass the tenant from the verified JWT.
 *
 * BOOKING IS SERIALISED. `bookOfferSlot` runs in one transaction: it locks the
 * offer row (FOR UPDATE), takes a transaction-scoped advisory lock per
 * panellist (sorted, so two bookings can never deadlock) and per
 * (application, round), then RE-CHECKS the slot against committed interviews
 * before inserting. Two picks of the same slot → exactly one books; the other
 * is told the slot was taken and handed the still-free remainder.
 */

import { sql as poolSql, applicationStageEnum, type ApplicationStage } from "@hireops/db";
import { signLink, hashToken } from "@hireops/notifications";
import {
  coerceScorecardCriteria,
  computeCommonSlots,
  isSlotFree,
  resolveSchedulingSettings,
  resolveScorecardCriteria,
  slotEngineConfigFrom,
  type ComputeSlotsInput,
  type Interval,
  type PanelistSchedule,
  type ProposedSlot,
  type ResolvedSchedulingSettings,
  type ScorecardCriterion,
  type SlotEngineConfig,
} from "@hireops/api-types";

type PoolSql = typeof poolSql;

export const PICK_SLOT_LINK_ACTION = "candidate.pick_interview_slot";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export type OfferReason =
  | "initial"
  | "candidate_reschedule"
  | "panelist_unavailable"
  | "recruiter_reschedule";

/** A refusal the caller maps to TRPCError / HTTP. */
export class SchedulingError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "SchedulingError";
  }
}

function portalBase(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
}

function toMs(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toIso(v: Date | string | null | undefined): string | null {
  const ms = toMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

/** A NOT NULL timestamptz column → epoch ms (0 only if the driver hands back garbage). */
function reqMs(v: Date | string): number {
  return toMs(v) ?? 0;
}

/** A NOT NULL timestamptz column → ISO string. */
function reqIso(v: Date | string): string {
  return new Date(reqMs(v)).toISOString();
}

function parseUuidArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    return v
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseSlots(v: unknown): ProposedSlot[] {
  const raw = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  if (!Array.isArray(raw)) return [];
  const out: ProposedSlot[] = [];
  for (const s of raw) {
    if (s && typeof s === "object") {
      const start = (s as { start?: unknown }).start;
      const end = (s as { end?: unknown }).end;
      if (typeof start === "string" && typeof end === "string") out.push({ start, end });
    }
  }
  return out;
}

/** "Tue 4 Aug, 10:00 (Europe/Berlin)" — emails can only show one zone, so they name it. */
export function formatInZone(instant: Date | number, timeZone: string): string {
  const d = typeof instant === "number" ? new Date(instant) : instant;
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${s} (${timeZone})`;
}

// ───────────────────────────── settings ─────────────────────────────

export async function loadSchedulingSettings(
  sql: PoolSql,
  tenantId: string,
): Promise<ResolvedSchedulingSettings> {
  const [row] = await sql<{ settings: unknown }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  return resolveSchedulingSettings(row?.settings ?? {});
}

// ───────────────────────────── schedules ─────────────────────────────

export interface PanelMemberInfo {
  membershipId: string;
  name: string | null;
  email: string | null;
  hasAvailability: boolean;
}

/**
 * Availability + exceptions + busy time for each panellist, over `range`.
 * `excludeInterviewId` drops one interview from busy time (used when asking
 * "is the replacement free at THIS interview's own time?").
 */
export async function loadPanelSchedules(
  sql: PoolSql,
  tenantId: string,
  membershipIds: string[],
  range: Interval,
  excludeInterviewId: string | null = null,
): Promise<PanelistSchedule[]> {
  if (membershipIds.length === 0) return [];
  const from = new Date(range.start - DAY_MS);
  const to = new Date(range.end + DAY_MS);
  const windows = await sql<
    {
      membership_id: string;
      day_of_week: number;
      start_minute: number;
      end_minute: number;
      timezone: string;
    }[]
  >`
    SELECT membership_id::text, day_of_week, start_minute, end_minute, timezone
    FROM public.panelist_availability_windows
    WHERE tenant_id = ${tenantId} AND membership_id = ANY(${membershipIds}::uuid[])
  `;
  const exceptions = await sql<
    { membership_id: string; starts_at: Date | string; ends_at: Date | string }[]
  >`
    SELECT membership_id::text, starts_at, ends_at
    FROM public.panelist_availability_exceptions
    WHERE tenant_id = ${tenantId} AND membership_id = ANY(${membershipIds}::uuid[])
      AND ends_at > ${from.toISOString()}::timestamptz AND starts_at < ${to.toISOString()}::timestamptz
  `;
  const busy = await sql<
    { membership_id: string; starts_at: Date | string; ends_at: Date | string }[]
  >`
    SELECT ip.membership_id::text,
           i.scheduled_start AS starts_at,
           COALESCE(i.scheduled_end, i.scheduled_start + make_interval(mins => i.duration_minutes)) AS ends_at
    FROM public.interview_panelists ip
    JOIN public.interviews i ON i.tenant_id = ip.tenant_id AND i.id = ip.interview_id
    WHERE ip.tenant_id = ${tenantId}
      AND ip.membership_id = ANY(${membershipIds}::uuid[])
      AND i.status = 'scheduled'
      AND i.mode <> 'ai_async'
      AND i.scheduled_start IS NOT NULL
      AND i.scheduled_start < ${to.toISOString()}::timestamptz
      AND COALESCE(i.scheduled_end, i.scheduled_start + make_interval(mins => i.duration_minutes)) > ${from.toISOString()}::timestamptz
      AND (${excludeInterviewId}::uuid IS NULL OR i.id <> ${excludeInterviewId}::uuid)
  `;
  return membershipIds.map((id) => ({
    membershipId: id,
    windows: windows
      .filter((w) => w.membership_id === id)
      .map((w) => ({
        dayOfWeek: Number(w.day_of_week),
        startMinute: Number(w.start_minute),
        endMinute: Number(w.end_minute),
        timezone: w.timezone,
      })),
    exceptions: exceptions
      .filter((e) => e.membership_id === id)
      .map((e) => ({ start: reqMs(e.starts_at), end: reqMs(e.ends_at) })),
    busy: busy
      .filter((b) => b.membership_id === id)
      .map((b) => ({ start: reqMs(b.starts_at), end: reqMs(b.ends_at) })),
  }));
}

/** The candidate's other live rounds on this application — nobody double-books them. */
async function loadCandidateBusy(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
  excludeInterviewId: string | null,
): Promise<Interval[]> {
  const rows = await sql<{ starts_at: Date | string; ends_at: Date | string }[]>`
    SELECT scheduled_start AS starts_at,
           COALESCE(scheduled_end, scheduled_start + make_interval(mins => duration_minutes)) AS ends_at
    FROM public.interviews
    WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
      AND status = 'scheduled' AND mode <> 'ai_async' AND scheduled_start IS NOT NULL
      AND (${excludeInterviewId}::uuid IS NULL OR id <> ${excludeInterviewId}::uuid)
  `;
  return rows.map((r) => ({ start: reqMs(r.starts_at), end: reqMs(r.ends_at) }));
}

export async function loadMemberInfo(
  sql: PoolSql,
  tenantId: string,
  membershipIds: string[],
): Promise<Map<string, { name: string | null; email: string | null; status: string }>> {
  const map = new Map<string, { name: string | null; email: string | null; status: string }>();
  if (membershipIds.length === 0) return map;
  const rows = await sql<
    { id: string; name: string | null; email: string | null; status: string }[]
  >`
    SELECT tum.id::text AS id, u.display_name AS name, au.email AS email, tum.status AS status
    FROM public.tenant_user_memberships tum
    LEFT JOIN public.users u ON u.id = tum.user_id
    LEFT JOIN auth.users au ON au.id = tum.user_id
    WHERE tum.tenant_id = ${tenantId} AND tum.id = ANY(${membershipIds}::uuid[])
  `;
  for (const r of rows) map.set(r.id, { name: r.name, email: r.email, status: r.status });
  return map;
}

async function assertActivePanel(sql: PoolSql, tenantId: string, ids: string[]): Promise<void> {
  const info = await loadMemberInfo(sql, tenantId, ids);
  const missing = ids.filter((id) => info.get(id)?.status !== "active");
  if (missing.length > 0) {
    throw new SchedulingError(
      "BAD_REQUEST",
      `Not active memberships in this tenant: ${missing.join(", ")}`,
    );
  }
}

// ───────────────────────────── proposal (PC-8) ─────────────────────────────

interface ApplicationRow {
  requisition_id: string;
  current_stage: ApplicationStage;
}

interface PlanRow {
  round_name: string;
  duration_minutes: number;
  mode: string;
  scorecard_template: string;
  default_panel_membership_ids: unknown;
  panel_pool_id: string | null;
}

async function loadApplication(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationRow> {
  const [app] = await sql<ApplicationRow[]>`
    SELECT requisition_id::text, current_stage
    FROM public.applications WHERE tenant_id = ${tenantId} AND id = ${applicationId} LIMIT 1
  `;
  if (!app) throw new SchedulingError("NOT_FOUND", "Application not found");
  return app;
}

async function loadPlanRound(
  sql: PoolSql,
  tenantId: string,
  requisitionId: string,
  roundNumber: number,
): Promise<PlanRow | null> {
  const [plan] = await sql<PlanRow[]>`
    SELECT round_name, duration_minutes, mode, scorecard_template,
           default_panel_membership_ids, panel_pool_id::text
    FROM public.interview_plans
    WHERE tenant_id = ${tenantId} AND requisition_id = ${requisitionId} AND round_number = ${roundNumber}
    LIMIT 1
  `;
  return plan ?? null;
}

export interface ProposeResult {
  slots: ProposedSlot[];
  totalFree: number;
  durationMinutes: number;
  timezone: string;
  panel: { membershipId: string; name: string | null; hasAvailability: boolean }[];
  emptyReason: string | null;
  roundName: string;
}

interface ComputeArgs {
  tenantId: string;
  applicationId: string;
  panel: string[];
  durationMinutes: number;
  settings: ResolvedSchedulingSettings;
  now: number;
  limit: number;
  horizonDaysOverride?: number;
  excludeInterviewId?: string | null;
}

async function buildEngineInput(
  sql: PoolSql,
  a: ComputeArgs,
): Promise<{ input: ComputeSlotsInput; config: SlotEngineConfig }> {
  const config = slotEngineConfigFrom(a.settings);
  if (a.horizonDaysOverride) config.horizonDays = a.horizonDaysOverride;
  const range = {
    start: a.now,
    end: a.now + config.horizonDays * DAY_MS,
  };
  const panelists = await loadPanelSchedules(
    sql,
    a.tenantId,
    a.panel,
    range,
    a.excludeInterviewId ?? null,
  );
  const extraBusy = await loadCandidateBusy(
    sql,
    a.tenantId,
    a.applicationId,
    a.excludeInterviewId ?? null,
  );
  return {
    input: { panelists, durationMinutes: a.durationMinutes, config, now: a.now, extraBusy },
    config,
  };
}

function emptyReasonFor(
  panel: { name: string | null; hasAvailability: boolean }[],
  settings: ResolvedSchedulingSettings,
  horizonDays: number,
): string {
  if (panel.length === 0) return "This round has no panel yet. Pick at least one panellist.";
  const missing = panel.filter((p) => !p.hasAvailability);
  if (missing.length > 0 && !settings.assumeWorkingHoursWhenNoAvailability) {
    const names = missing.map((p) => p.name ?? "A panellist").join(", ");
    return `${names} ${missing.length === 1 ? "has" : "have"} not set any availability yet, so no common time can be found.`;
  }
  return `No time in the next ${horizonDays} days when the whole panel is free (working hours ${settings.workingHoursStart}–${settings.workingHoursEnd} ${settings.timezone}, ${settings.minNoticeHours}h notice, ${settings.bufferMinutes} min buffer).`;
}

export async function proposeSlotsForRound(
  sql: PoolSql,
  tenantId: string,
  input: {
    applicationId: string;
    roundNumber: number;
    durationMinutes?: number;
    panelMembershipIds?: string[];
    limit?: number;
    horizonDaysOverride?: number;
  },
  now: number = Date.now(),
): Promise<ProposeResult> {
  const app = await loadApplication(sql, tenantId, input.applicationId);
  const plan = await loadPlanRound(sql, tenantId, app.requisition_id, input.roundNumber);
  if (!plan) {
    throw new SchedulingError(
      "BAD_REQUEST",
      `No interview plan round ${input.roundNumber} on this requisition. Define the plan first.`,
    );
  }
  const settings = await loadSchedulingSettings(sql, tenantId);
  const panel = [
    ...new Set(input.panelMembershipIds ?? parseUuidArray(plan.default_panel_membership_ids)),
  ];
  if (panel.length > 0) await assertActivePanel(sql, tenantId, panel);
  const durationMinutes = input.durationMinutes ?? plan.duration_minutes;
  const limit = input.limit ?? settings.maxSlotsOffered;
  const { input: engineInput, config } = await buildEngineInput(sql, {
    tenantId,
    applicationId: input.applicationId,
    panel,
    durationMinutes,
    settings,
    now,
    limit,
    horizonDaysOverride: input.horizonDaysOverride,
  });
  const info = await loadMemberInfo(sql, tenantId, panel);
  const panelView = engineInput.panelists.map((p) => ({
    membershipId: p.membershipId,
    name: info.get(p.membershipId)?.name ?? info.get(p.membershipId)?.email ?? null,
    hasAvailability: p.windows.length > 0,
  }));
  const result = computeCommonSlots(engineInput, limit);
  return {
    slots: result.slots,
    totalFree: result.totalFree,
    durationMinutes,
    timezone: settings.timezone,
    panel: panelView,
    emptyReason:
      result.slots.length === 0 ? emptyReasonFor(panelView, settings, config.horizonDays) : null,
    roundName: plan.round_name,
  };
}

// ───────────────────────────── notifications ─────────────────────────────

interface RawEnqueue {
  tenantId: string;
  recipientType: "candidate" | "recruiter" | "panelist";
  recipientEmail: string;
  recipientMembershipId?: string | null;
  recipientCandidateId?: string | null;
  templateKey: string;
  templateData: Record<string, unknown>;
  dedupKey: string;
}

/**
 * notification_outbox insert on the pool / a transaction. ON CONFLICT DO
 * NOTHING against the partial unique (tenant_id, dedup_key): a retried call is
 * "already queued", not an error. EVERY dedup key below includes its recipient
 * (the trap that once emailed only one of several recipients).
 */
async function enqueueRaw(sql: PoolSql, a: RawEnqueue): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO public.notification_outbox
      (tenant_id, recipient_type, recipient_email, recipient_membership_id,
       recipient_candidate_id, template_key, template_data, dedup_key, status)
    VALUES (${a.tenantId}, ${a.recipientType}, ${a.recipientEmail},
            ${a.recipientMembershipId ?? null}, ${a.recipientCandidateId ?? null},
            ${a.templateKey}, ${JSON.stringify(a.templateData)}::jsonb, ${a.dedupKey}, 'pending')
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

interface CandidateContext {
  candidate_id: string;
  candidate_name: string | null;
  candidate_email: string | null;
  position_title: string;
  company_name: string;
  primary_recruiter_id: string | null;
}

async function loadCandidateContext(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
): Promise<CandidateContext | null> {
  const [row] = await sql<CandidateContext[]>`
    SELECT c.id::text AS candidate_id, p.full_name AS candidate_name, p.email_primary AS candidate_email,
           pos.title AS position_title, t.display_name AS company_name,
           r.primary_recruiter_id::text AS primary_recruiter_id
    FROM public.applications a
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
    JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
    JOIN public.tenants t ON t.id = a.tenant_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * The recruiter's action-needed alert (no common slot). Email via the outbox,
 * de-duplicated per recipient, application, round and UTC day so a recruiter
 * clicking "Find common slots" repeatedly is told once a day, not every click.
 */
export async function alertRecruiterNoSlots(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
  roundNumber: number,
  roundName: string,
  detail: string,
): Promise<boolean> {
  const ctx = await loadCandidateContext(sql, tenantId, applicationId);
  if (!ctx?.primary_recruiter_id) return false;
  const info = await loadMemberInfo(sql, tenantId, [ctx.primary_recruiter_id]);
  const rec = info.get(ctx.primary_recruiter_id);
  if (!rec?.email) return false;
  const day = new Date().toISOString().slice(0, 10);
  await enqueueRaw(sql, {
    tenantId,
    recipientType: "recruiter",
    recipientEmail: rec.email,
    recipientMembershipId: ctx.primary_recruiter_id,
    templateKey: "recruiter.scheduling_alert",
    templateData: {
      recipientName: rec.name ?? "there",
      candidateName: ctx.candidate_name ?? "the candidate",
      positionTitle: ctx.position_title,
      roundName,
      detail,
      actionUrl: `${portalBase()}/interviews`,
    },
    dedupKey: `scheduling_alert:${applicationId}:${roundNumber}:${ctx.primary_recruiter_id}:${day}`,
  });
  return true;
}

// ───────────────────────────── offers (PC-9) ─────────────────────────────

export interface CreateOfferArgs {
  tenantId: string;
  applicationId: string;
  roundNumber: number;
  panelMembershipIds: string[];
  leadMembershipId?: string | null;
  durationMinutes?: number;
  mode?: "video" | "onsite" | "phone";
  meetingUrl?: string | null;
  /** Optional subset of starts to offer (each must be currently free). */
  slotStarts?: string[];
  reason: OfferReason;
  replacesInterviewId?: string | null;
  createdByMembershipId: string;
  now?: number;
}

export interface CreateOfferResult {
  offerId: string | null;
  slots: ProposedSlot[];
  expiresAt: string | null;
  sentTo: string | null;
  emptyReason: string | null;
  recruiterAlerted: boolean;
}

/**
 * Compute free slots for the panel, supersede any open offer for this
 * (application, round), store the new offer with its signed link and email the
 * candidate. With no free slot: NO offer row, the recruiter is alerted, and the
 * reason is returned.
 */
export async function createSlotOffer(
  sql: PoolSql,
  a: CreateOfferArgs,
): Promise<CreateOfferResult> {
  const now = a.now ?? Date.now();
  const panel = [...new Set(a.panelMembershipIds)];
  if (panel.length === 0) {
    throw new SchedulingError("BAD_REQUEST", "Pick at least one panellist.");
  }
  if (a.leadMembershipId && !panel.includes(a.leadMembershipId)) {
    throw new SchedulingError("BAD_REQUEST", "The lead must be on the panel.");
  }
  const app = await loadApplication(sql, a.tenantId, a.applicationId);
  const plan = await loadPlanRound(sql, a.tenantId, app.requisition_id, a.roundNumber);
  if (!plan) {
    throw new SchedulingError(
      "BAD_REQUEST",
      `No interview plan round ${a.roundNumber} on this requisition. Define the plan first.`,
    );
  }
  const mode = (a.mode ?? plan.mode) as string;
  if (mode === "ai_async") {
    throw new SchedulingError(
      "BAD_REQUEST",
      "An AI first round has no live time to pick. Schedule it directly.",
    );
  }
  await assertActivePanel(sql, a.tenantId, panel);
  if (!a.replacesInterviewId) {
    const [clash] = await sql<{ id: string }[]>`
      SELECT id FROM public.interviews
      WHERE tenant_id = ${a.tenantId} AND application_id = ${a.applicationId}
        AND round_number = ${a.roundNumber} AND status <> 'cancelled'
      LIMIT 1
    `;
    if (clash) {
      throw new SchedulingError(
        "CONFLICT",
        `Round ${a.roundNumber} is already scheduled. Reschedule it instead.`,
      );
    }
  }

  const settings = await loadSchedulingSettings(sql, a.tenantId);
  const durationMinutes = a.durationMinutes ?? plan.duration_minutes;
  const { input, config } = await buildEngineInput(sql, {
    tenantId: a.tenantId,
    applicationId: a.applicationId,
    panel,
    durationMinutes,
    settings,
    now,
    limit: settings.maxSlotsOffered,
  });

  let slots: ProposedSlot[];
  if (a.slotStarts && a.slotStarts.length > 0) {
    const starts = [...new Set(a.slotStarts.map((s) => new Date(s).getTime()))].sort(
      (x, y) => x - y,
    );
    const free = starts.filter((s) => isSlotFree(input, s));
    if (free.length < starts.length) {
      throw new SchedulingError(
        "CONFLICT",
        "One or more of the chosen times is no longer free. Find common slots again.",
      );
    }
    slots = free.slice(0, settings.maxSlotsOffered).map((s) => ({
      start: new Date(s).toISOString(),
      end: new Date(s + durationMinutes * MINUTE_MS).toISOString(),
    }));
  } else {
    slots = computeCommonSlots(input, settings.maxSlotsOffered).slots;
  }

  const roundName = plan.round_name;
  if (slots.length === 0) {
    const info = await loadMemberInfo(sql, a.tenantId, panel);
    const panelView = input.panelists.map((p) => ({
      name: info.get(p.membershipId)?.name ?? info.get(p.membershipId)?.email ?? null,
      hasAvailability: p.windows.length > 0,
    }));
    const emptyReason = emptyReasonFor(panelView, settings, config.horizonDays);
    const recruiterAlerted = await alertRecruiterNoSlots(
      sql,
      a.tenantId,
      a.applicationId,
      a.roundNumber,
      roundName,
      emptyReason,
    );
    return {
      offerId: null,
      slots: [],
      expiresAt: null,
      sentTo: null,
      emptyReason,
      recruiterAlerted,
    };
  }

  const expiresAt = new Date(now + settings.offerLinkValidityHours * HOUR_MS);
  const ctx = await loadCandidateContext(sql, a.tenantId, a.applicationId);

  const offerId = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PoolSql;
    await tx`
      UPDATE public.interview_slot_offers
      SET status = 'superseded', updated_at = now()
      WHERE tenant_id = ${a.tenantId} AND application_id = ${a.applicationId}
        AND round_number = ${a.roundNumber} AND status = 'open'
    `;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO public.interview_slot_offers
        (tenant_id, application_id, requisition_id, round_number, round_name,
         replaces_interview_id, reason, status, panel_membership_ids, lead_membership_id,
         duration_minutes, mode, meeting_url, slots, timezone, expires_at,
         created_by_membership_id)
      VALUES (${a.tenantId}, ${a.applicationId}, ${app.requisition_id}, ${a.roundNumber},
              ${roundName}, ${a.replacesInterviewId ?? null}, ${a.reason}, 'open',
              ${panel}::uuid[], ${a.leadMembershipId ?? null}, ${durationMinutes}, ${mode},
              ${a.meetingUrl ?? null}, ${JSON.stringify(slots)}::jsonb, ${settings.timezone},
              ${expiresAt.toISOString()}::timestamptz, ${a.createdByMembershipId})
      RETURNING id::text
    `;
    if (!row) throw new Error("interview_slot_offers insert returned no row");
    const signed = signLink({ action: PICK_SLOT_LINK_ACTION, subjectId: row.id, expiresAt });
    await tx`
      UPDATE public.interview_slot_offers SET token_hash = ${hashToken(signed)}
      WHERE tenant_id = ${a.tenantId} AND id = ${row.id}
    `;
    if (ctx?.candidate_email) {
      await enqueueRaw(tx, {
        tenantId: a.tenantId,
        recipientType: "candidate",
        recipientEmail: ctx.candidate_email,
        recipientCandidateId: ctx.candidate_id,
        templateKey: "candidate.interview_slot_offer",
        templateData: {
          candidateName: ctx.candidate_name ?? "there",
          companyName: ctx.company_name,
          positionTitle: ctx.position_title,
          roundName,
          durationMinutes,
          reason: a.reason,
          slotLines: slots.map((s) => formatInZone(new Date(s.start), settings.timezone)),
          expiresAtFormatted: formatInZone(expiresAt, settings.timezone),
          pickUrl: `${portalBase()}/interviews/pick/${signed}`,
        },
        dedupKey: `interview_slot_offer:${row.id}:${ctx.candidate_id}`,
      });
    }
    return row.id;
  });

  return {
    offerId,
    slots,
    expiresAt: expiresAt.toISOString(),
    sentTo: ctx?.candidate_email ?? null,
    emptyReason: null,
    recruiterAlerted: false,
  };
}

interface OfferRow {
  id: string;
  tenant_id: string;
  application_id: string;
  requisition_id: string;
  round_number: number;
  round_name: string;
  replaces_interview_id: string | null;
  booked_interview_id: string | null;
  reason: OfferReason;
  status: string;
  panel_membership_ids: unknown;
  lead_membership_id: string | null;
  duration_minutes: number;
  mode: string;
  meeting_url: string | null;
  slots: unknown;
  timezone: string;
  expires_at: Date | string;
  booked_slot_start: Date | string | null;
  created_by_membership_id: string;
  created_at: Date | string;
}

const OFFER_COLUMNS = `
  id::text, tenant_id::text, application_id::text, requisition_id::text, round_number,
  round_name, replaces_interview_id::text, booked_interview_id::text, reason, status,
  panel_membership_ids, lead_membership_id::text, duration_minutes, mode, meeting_url, slots,
  timezone, expires_at, booked_slot_start, created_by_membership_id::text, created_at
`;

export async function loadOfferByTokenHash(
  sql: PoolSql,
  tokenHash: string,
): Promise<OfferRow | null> {
  const [row] = await sql.unsafe<OfferRow[]>(
    `SELECT ${OFFER_COLUMNS} FROM public.interview_slot_offers WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  return row ?? null;
}

export async function loadOfferById(
  sql: PoolSql,
  tenantId: string,
  offerId: string,
): Promise<OfferRow | null> {
  const [row] = await sql.unsafe<OfferRow[]>(
    `SELECT ${OFFER_COLUMNS} FROM public.interview_slot_offers WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, offerId],
  );
  return row ?? null;
}

/** Engine input for an offer's panel, as of `now`. */
async function engineInputForOffer(
  sql: PoolSql,
  offer: OfferRow,
  now: number,
): Promise<ComputeSlotsInput> {
  const settings = await loadSchedulingSettings(sql, offer.tenant_id);
  const { input } = await buildEngineInput(sql, {
    tenantId: offer.tenant_id,
    applicationId: offer.application_id,
    panel: parseUuidArray(offer.panel_membership_ids),
    durationMinutes: offer.duration_minutes,
    settings,
    now,
    limit: settings.maxSlotsOffered,
  });
  return input;
}

/** The offered slots that are still free right now. */
export async function stillFreeSlots(
  sql: PoolSql,
  offer: OfferRow,
  now: number = Date.now(),
): Promise<ProposedSlot[]> {
  const input = await engineInputForOffer(sql, offer, now);
  return parseSlots(offer.slots).filter((s) => isSlotFree(input, new Date(s.start).getTime()));
}

export interface CandidateOfferView {
  offerId: string;
  status: "open" | "booked" | "expired" | "cancelled" | "superseded";
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  durationMinutes: number;
  mode: string;
  reason: OfferReason;
  expiresAt: string;
  replacesInterviewId: string | null;
  slots: ProposedSlot[];
  bookedSlotStart: string | null;
}

/** Lazy expiry: an open offer past its expiry is stamped `expired` on read. */
async function expireIfLapsed(sql: PoolSql, offer: OfferRow, now: number): Promise<OfferRow> {
  if (offer.status === "open" && (toMs(offer.expires_at) ?? 0) <= now) {
    await sql`
      UPDATE public.interview_slot_offers SET status = 'expired', updated_at = now()
      WHERE tenant_id = ${offer.tenant_id} AND id = ${offer.id} AND status = 'open'
    `;
    return { ...offer, status: "expired" };
  }
  return offer;
}

export async function candidateOfferView(
  sql: PoolSql,
  offerIn: OfferRow,
  now: number = Date.now(),
): Promise<CandidateOfferView> {
  const offer = await expireIfLapsed(sql, offerIn, now);
  const ctx = await loadCandidateContext(sql, offer.tenant_id, offer.application_id);
  const slots = offer.status === "open" ? await stillFreeSlots(sql, offer, now) : [];
  return {
    offerId: offer.id,
    status: offer.status as CandidateOfferView["status"],
    candidateName: ctx?.candidate_name ?? "there",
    companyName: ctx?.company_name ?? "",
    positionTitle: ctx?.position_title ?? "",
    roundName: offer.round_name,
    durationMinutes: offer.duration_minutes,
    mode: offer.mode,
    reason: offer.reason,
    expiresAt: reqIso(offer.expires_at),
    replacesInterviewId: offer.replaces_interview_id,
    slots,
    bookedSlotStart: toIso(offer.booked_slot_start),
  };
}

export type BookRefusal =
  | "offer_not_found"
  | "offer_closed"
  | "already_booked"
  | "offer_expired"
  | "slot_not_offered"
  | "slot_taken"
  | "round_already_scheduled";

export type BookResult =
  | { ok: true; interviewId: string; scheduledStart: string; tenantId: string; offerId: string }
  | {
      ok: false;
      reason: BookRefusal;
      tenantId: string | null;
      offerId: string | null;
      /** For slot_taken: the offered slots still free, so the page can refresh. */
      slots?: ProposedSlot[];
    };

/**
 * Book one of an offer's slots. See the file header for the locking. The
 * caller identifies the offer by token hash (public link) or id + tenant
 * (candidate portal, after its own ownership check).
 */
export async function bookOfferSlot(
  sql: PoolSql,
  args: {
    by: { tokenHash: string } | { tenantId: string; offerId: string };
    slotStart: string;
    via: "candidate_link" | "candidate_portal";
    ip?: string | null;
    now?: number;
  },
): Promise<BookResult> {
  const now = args.now ?? Date.now();
  const startMs = new Date(args.slotStart).getTime();

  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PoolSql;
    const [offer] =
      "tokenHash" in args.by
        ? await tx.unsafe<OfferRow[]>(
            `SELECT ${OFFER_COLUMNS} FROM public.interview_slot_offers WHERE token_hash = $1 LIMIT 1 FOR UPDATE`,
            [args.by.tokenHash],
          )
        : await tx.unsafe<OfferRow[]>(
            `SELECT ${OFFER_COLUMNS} FROM public.interview_slot_offers WHERE tenant_id = $1 AND id = $2 LIMIT 1 FOR UPDATE`,
            [args.by.tenantId, args.by.offerId],
          );
    if (!offer) return { ok: false, reason: "offer_not_found", tenantId: null, offerId: null };
    const base = { tenantId: offer.tenant_id, offerId: offer.id };

    if (offer.status === "booked") return { ok: false, reason: "already_booked", ...base };
    if (offer.status !== "open") return { ok: false, reason: "offer_closed", ...base };
    if ((toMs(offer.expires_at) ?? 0) <= now) {
      await tx`
        UPDATE public.interview_slot_offers SET status = 'expired', updated_at = now()
        WHERE tenant_id = ${offer.tenant_id} AND id = ${offer.id}
      `;
      return { ok: false, reason: "offer_expired", ...base };
    }
    const offered = parseSlots(offer.slots).some((s) => new Date(s.start).getTime() === startMs);
    if (!offered || Number.isNaN(startMs)) {
      return { ok: false, reason: "slot_not_offered", ...base };
    }

    // Serialise every booking that could touch these panellists or this round.
    const panel = parseUuidArray(offer.panel_membership_ids);
    const keys = [
      ...panel.map((m) => `interview_slot:${offer.tenant_id}:${m}`),
      `interview_round:${offer.tenant_id}:${offer.application_id}:${offer.round_number}`,
    ].sort();
    for (const k of keys) {
      // hashtext is 32-bit: a collision only over-serialises, never under-locks.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
    }

    // Re-check against COMMITTED state, now that nobody else can book these people.
    const input = await engineInputForOffer(tx, offer, now);
    if (!isSlotFree(input, startMs)) {
      const slots = parseSlots(offer.slots).filter((s) =>
        isSlotFree(input, new Date(s.start).getTime()),
      );
      return { ok: false, reason: "slot_taken", ...base, slots };
    }

    const [clash] = await tx<{ id: string }[]>`
      SELECT id::text FROM public.interviews
      WHERE tenant_id = ${offer.tenant_id} AND application_id = ${offer.application_id}
        AND round_number = ${offer.round_number} AND status <> 'cancelled'
        AND (${offer.replaces_interview_id}::uuid IS NULL OR id <> ${offer.replaces_interview_id}::uuid)
      LIMIT 1
    `;
    if (clash) {
      await tx`
        UPDATE public.interview_slot_offers SET status = 'superseded', updated_at = now()
        WHERE tenant_id = ${offer.tenant_id} AND id = ${offer.id}
      `;
      return { ok: false, reason: "round_already_scheduled", ...base };
    }

    const interviewId = await insertBookedInterview(tx, offer, startMs);

    await tx`
      UPDATE public.interview_slot_offers
      SET status = 'booked', booked_interview_id = ${interviewId},
          booked_slot_start = ${new Date(startMs).toISOString()}::timestamptz, booked_at = now(),
          booked_via = ${args.via}, updated_at = now()
      WHERE tenant_id = ${offer.tenant_id} AND id = ${offer.id}
    `;

    if ("tokenHash" in args.by) {
      // The link's single successful redemption. Partial unique on
      // (tenant_id, token_hash) WHERE successful → DO NOTHING on a repeat.
      await tx`
        INSERT INTO public.signed_link_uses
          (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful)
        VALUES (${offer.tenant_id}, ${args.by.tokenHash}, ${PICK_SLOT_LINK_ACTION}, ${offer.id},
                ${args.ip ?? null}, true)
        ON CONFLICT DO NOTHING
      `;
    }

    return {
      ok: true,
      interviewId,
      scheduledStart: new Date(startMs).toISOString(),
      ...base,
    };
  });
}

const STAGE_ORDER: Record<string, number> = Object.fromEntries(
  applicationStageEnum.enumValues.map((s, i) => [s, i]),
);

/**
 * The booking itself, inside bookOfferSlot's transaction: cancel the replaced
 * round, insert the new one from its plan round (scorecard snapshot exactly as
 * doScheduleRound does), mint the confirm link, write the panel, move the
 * application stage forward if the round demands it, and queue the invitation
 * (candidate) + calendar invites (panellists).
 *
 * The candidate PICKED this time, so the round is stamped confirmed — asking
 * them to confirm a time they just chose would be noise. The confirm link is
 * still issued (it carries recording consent, if the recruiter asks for it).
 */
async function insertBookedInterview(
  tx: PoolSql,
  offer: OfferRow,
  startMs: number,
): Promise<string> {
  const tenantId = offer.tenant_id;
  const panel = parseUuidArray(offer.panel_membership_ids);

  let scorecardTemplate: string | null = null;
  let snapshot: unknown = null;
  const plan = await loadPlanRound(tx, tenantId, offer.requisition_id, offer.round_number);
  if (offer.replaces_interview_id) {
    const [old] = await tx<
      {
        scorecard_template: string | null;
        scorecard_criteria_snapshot: unknown;
      }[]
    >`
      SELECT scorecard_template, scorecard_criteria_snapshot
      FROM public.interviews WHERE tenant_id = ${tenantId} AND id = ${offer.replaces_interview_id}
    `;
    if (old) {
      // A reschedule keeps the rubric the round was scheduled against.
      scorecardTemplate = old.scorecard_template;
      snapshot = old.scorecard_criteria_snapshot;
    }
    await tx`
      UPDATE public.interviews
      SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${offer.replaces_interview_id} AND status = 'scheduled'
    `;
  }
  if (!scorecardTemplate && plan) {
    scorecardTemplate = plan.scorecard_template;
    const custom = await tx<{ scorecard_key: string; criteria: unknown }[]>`
      SELECT scorecard_key, criteria FROM public.tenant_scorecard_template
      WHERE tenant_id = ${tenantId}
    `;
    const map = new Map<string, readonly ScorecardCriterion[]>();
    for (const r of custom) {
      const c = coerceScorecardCriteria(r.criteria);
      if (c.length > 0) map.set(r.scorecard_key, c);
    }
    snapshot = resolveScorecardCriteria(plan.scorecard_template, map);
  }

  const end = startMs + offer.duration_minutes * MINUTE_MS;
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO public.interviews
      (tenant_id, application_id, requisition_id, round_number, round_name, status,
       scorecard_template, scorecard_criteria_snapshot, scheduled_start, scheduled_end,
       duration_minutes, mode, meeting_url, candidate_confirmed_at, created_by_membership_id)
    VALUES (${tenantId}, ${offer.application_id}, ${offer.requisition_id}, ${offer.round_number},
            ${offer.round_name}, 'scheduled', ${scorecardTemplate},
            ${snapshot === null ? null : JSON.stringify(snapshot)}::jsonb,
            ${new Date(startMs).toISOString()}::timestamptz, ${new Date(end).toISOString()}::timestamptz, ${offer.duration_minutes}, ${offer.mode},
            ${offer.meeting_url}, now(), ${offer.created_by_membership_id})
    RETURNING id::text
  `;
  if (!created) throw new Error("interviews insert returned no row");
  const interviewId = created.id;

  const confirmExpires = new Date(Math.max(startMs, Date.now()) + DAY_MS);
  const confirmToken = signLink({
    action: "candidate.confirm_interview",
    subjectId: interviewId,
    expiresAt: confirmExpires,
  });
  await tx`
    UPDATE public.interviews SET confirm_signed_link_token_hash = ${hashToken(confirmToken)}
    WHERE tenant_id = ${tenantId} AND id = ${interviewId}
  `;

  for (const m of panel) {
    await tx`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${tenantId}, ${interviewId}, ${m}, ${m === offer.lead_membership_id})
    `;
  }

  // Forward-only stage sync (doScheduleRound's syncStageForRound, in SQL).
  const target: ApplicationStage = scorecardTemplate === "hr" ? "hr_round" : "tech_interview";
  const [app] = await tx<{ current_stage: ApplicationStage }[]>`
    SELECT current_stage FROM public.applications
    WHERE tenant_id = ${tenantId} AND id = ${offer.application_id} FOR UPDATE
  `;
  if (app && (STAGE_ORDER[target] ?? 0) > (STAGE_ORDER[app.current_stage] ?? 0)) {
    await tx`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, actor_membership_id, reason)
      VALUES (${tenantId}, ${offer.application_id}, ${app.current_stage}, ${target},
              ${offer.created_by_membership_id}, ${`Candidate booked "${offer.round_name}"`})
    `;
    await tx`
      UPDATE public.applications SET current_stage = ${target}, stage_entered_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${offer.application_id}
    `;
  }

  await queueBookingEmails(tx, {
    tenantId,
    applicationId: offer.application_id,
    interviewId,
    roundName: offer.round_name,
    startMs,
    durationMinutes: offer.duration_minutes,
    mode: offer.mode,
    meetingUrl: offer.meeting_url ?? "",
    panel,
    confirmUrl: `${portalBase()}/interviews/confirm/${confirmToken}`,
    timezone: offer.timezone,
  });
  return interviewId;
}

/**
 * The candidate invitation (same template + .ics as a recruiter-scheduled
 * round) and one calendar invite per panellist (new — PC-9).
 */
async function queueBookingEmails(
  sql: PoolSql,
  a: {
    tenantId: string;
    applicationId: string;
    interviewId: string;
    roundName: string;
    startMs: number;
    durationMinutes: number;
    mode: string;
    meetingUrl: string;
    panel: string[];
    confirmUrl: string;
    timezone: string;
  },
): Promise<void> {
  const ctx = await loadCandidateContext(sql, a.tenantId, a.applicationId);
  if (!ctx) return;
  const modeLabel = MODE_LABEL[a.mode] ?? a.mode;
  const startIso = new Date(a.startMs).toISOString();
  if (ctx.candidate_email) {
    await enqueueRaw(sql, {
      tenantId: a.tenantId,
      recipientType: "candidate",
      recipientEmail: ctx.candidate_email,
      recipientCandidateId: ctx.candidate_id,
      templateKey: "candidate.interview_invitation",
      templateData: {
        candidateName: ctx.candidate_name ?? "there",
        companyName: ctx.company_name,
        positionTitle: ctx.position_title,
        roundName: a.roundName,
        interviewWhenFormatted: formatInZone(a.startMs, a.timezone),
        modeLabel,
        durationMinutes: a.durationMinutes,
        meetingUrl: a.meetingUrl,
        confirmUrl: a.confirmUrl,
        interviewStartIso: startIso,
        interviewId: a.interviewId,
      },
      dedupKey: `interview_invitation:${a.interviewId}`,
    });
  }
  await queuePanelistInvites(sql, {
    tenantId: a.tenantId,
    interviewId: a.interviewId,
    membershipIds: a.panel,
    candidateName: ctx.candidate_name ?? "Candidate",
    companyName: ctx.company_name,
    positionTitle: ctx.position_title,
    roundName: a.roundName,
    startMs: a.startMs,
    durationMinutes: a.durationMinutes,
    mode: a.mode,
    meetingUrl: a.meetingUrl,
    timezone: a.timezone,
  });
}

/** One `panelist.interview_scheduled` (with .ics) per panellist that has an email. */
export async function queuePanelistInvites(
  sql: PoolSql,
  a: {
    tenantId: string;
    interviewId: string;
    membershipIds: string[];
    candidateName: string;
    companyName: string;
    positionTitle: string;
    roundName: string;
    startMs: number;
    durationMinutes: number;
    mode: string;
    meetingUrl: string;
    timezone: string;
  },
): Promise<number> {
  if (a.mode === "ai_async" || a.membershipIds.length === 0) return 0;
  const info = await loadMemberInfo(sql, a.tenantId, a.membershipIds);
  let n = 0;
  for (const m of a.membershipIds) {
    const member = info.get(m);
    if (!member?.email) continue;
    const queued = await enqueueRaw(sql, {
      tenantId: a.tenantId,
      recipientType: "panelist",
      recipientEmail: member.email,
      recipientMembershipId: m,
      templateKey: "panelist.interview_scheduled",
      templateData: {
        panelistName: member.name ?? "there",
        candidateName: a.candidateName,
        companyName: a.companyName,
        positionTitle: a.positionTitle,
        roundName: a.roundName,
        interviewWhenFormatted: formatInZone(a.startMs, a.timezone),
        modeLabel: MODE_LABEL[a.mode] ?? a.mode,
        durationMinutes: a.durationMinutes,
        meetingUrl: a.meetingUrl,
        briefUrl: `${portalBase()}/panel/${a.interviewId}`,
        interviewStartIso: new Date(a.startMs).toISOString(),
        interviewId: a.interviewId,
      },
      dedupKey: `panelist_invite:${a.interviewId}:${m}`,
    });
    if (queued) n += 1;
  }
  return n;
}

// ───────────────────────────── re-offers (PC-9 / PC-10) ─────────────────────────────

interface LiveInterview {
  id: string;
  tenant_id: string;
  application_id: string;
  requisition_id: string;
  round_number: number;
  round_name: string;
  status: string;
  scheduled_start: Date | string | null;
  scheduled_end: Date | string | null;
  duration_minutes: number;
  mode: string;
  meeting_url: string | null;
  created_by_membership_id: string;
}

export async function loadInterview(
  sql: PoolSql,
  tenantId: string,
  interviewId: string,
): Promise<{ row: LiveInterview; panel: { membershipId: string; isLead: boolean }[] } | null> {
  const [row] = await sql<LiveInterview[]>`
    SELECT id::text, tenant_id::text, application_id::text, requisition_id::text, round_number,
           round_name, status, scheduled_start, scheduled_end, duration_minutes, mode,
           meeting_url, created_by_membership_id::text
    FROM public.interviews WHERE tenant_id = ${tenantId} AND id = ${interviewId} LIMIT 1
  `;
  if (!row) return null;
  const panel = await sql<{ membership_id: string; is_lead: boolean }[]>`
    SELECT membership_id::text, is_lead FROM public.interview_panelists
    WHERE tenant_id = ${tenantId} AND interview_id = ${interviewId}
  `;
  return {
    row,
    panel: panel.map((p) => ({ membershipId: p.membership_id, isLead: p.is_lead })),
  };
}

function interviewInterval(row: LiveInterview): Interval | null {
  const start = toMs(row.scheduled_start);
  if (start === null) return null;
  const end = toMs(row.scheduled_end) ?? start + row.duration_minutes * MINUTE_MS;
  return { start, end };
}

/**
 * Offer the candidate new times for an existing round (it stays booked until
 * they pick). Used by the candidate's own reschedule and by PC-10.
 */
export async function reofferForInterview(
  sql: PoolSql,
  iv: { row: LiveInterview; panel: { membershipId: string; isLead: boolean }[] },
  reason: OfferReason,
  now: number = Date.now(),
): Promise<CreateOfferResult> {
  const mode = iv.row.mode === "ai_async" ? "video" : (iv.row.mode as "video" | "onsite" | "phone");
  return createSlotOffer(sql, {
    tenantId: iv.row.tenant_id,
    applicationId: iv.row.application_id,
    roundNumber: iv.row.round_number,
    panelMembershipIds: iv.panel.map((p) => p.membershipId),
    leadMembershipId: iv.panel.find((p) => p.isLead)?.membershipId ?? null,
    durationMinutes: iv.row.duration_minutes,
    mode,
    meetingUrl: iv.row.meeting_url,
    reason,
    replacesInterviewId: iv.row.id,
    createdByMembershipId: iv.row.created_by_membership_id,
    now,
  });
}

/** "Rescheduling in progress" to the recruiter + the panellists still on the round. */
async function notifyRescheduling(
  sql: PoolSql,
  iv: { row: LiveInterview; panel: { membershipId: string; isLead: boolean }[] },
  excludeMembershipId: string | null,
  detail: string,
  offerId: string,
): Promise<void> {
  const ctx = await loadCandidateContext(sql, iv.row.tenant_id, iv.row.application_id);
  if (!ctx) return;
  const recipients = new Set(
    iv.panel.map((p) => p.membershipId).filter((m) => m !== excludeMembershipId),
  );
  if (ctx.primary_recruiter_id) recipients.add(ctx.primary_recruiter_id);
  const info = await loadMemberInfo(sql, iv.row.tenant_id, [...recipients]);
  for (const m of recipients) {
    const member = info.get(m);
    if (!member?.email) continue;
    await enqueueRaw(sql, {
      tenantId: iv.row.tenant_id,
      recipientType: m === ctx.primary_recruiter_id ? "recruiter" : "panelist",
      recipientEmail: member.email,
      recipientMembershipId: m,
      templateKey: "panelist.interview_rescheduling",
      templateData: {
        recipientName: member.name ?? "there",
        candidateName: ctx.candidate_name ?? "the candidate",
        positionTitle: ctx.position_title,
        roundName: iv.row.round_name,
        detail,
        actionUrl: `${portalBase()}/interviews`,
      },
      dedupKey: `interview_rescheduling:${offerId}:${m}`,
    });
  }
}

export interface CannotAttendResult {
  interviewId: string;
  exceptionId: string;
  offerId: string | null;
  slotsOffered: number;
  replacedWith: string | null;
  recruiterAlerted: boolean;
}

/**
 * PC-10 — a panellist can't attend an upcoming round.
 *
 * 1. Record a `cannot_attend` exception over the round's time (this is what
 *    makes the round "need rescheduling", and what keeps that window out of any
 *    new proposal for that panellist).
 * 2. If the recruiter named a replacement from the round's panel pool, swap
 *    them in. If the replacement is free at the ORIGINAL time, nothing else
 *    changes for the candidate — the replacement gets the invite and we stop.
 * 3. Otherwise offer the candidate new times automatically, tell the recruiter
 *    and the remaining panellists, and alert the recruiter if no time exists.
 */
export async function markCannotAttend(
  sql: PoolSql,
  a: {
    tenantId: string;
    interviewId: string;
    membershipId: string;
    reason?: string | null;
    replacementMembershipId?: string | null;
    actorMembershipId: string | null;
    now?: number;
  },
): Promise<CannotAttendResult> {
  const now = a.now ?? Date.now();
  const iv = await loadInterview(sql, a.tenantId, a.interviewId);
  if (!iv) throw new SchedulingError("NOT_FOUND", "Interview not found");
  const window = interviewInterval(iv.row);
  if (iv.row.status !== "scheduled" || !window || window.end <= now) {
    throw new SchedulingError("CONFLICT", "Only an upcoming scheduled interview can be changed.");
  }
  if (iv.row.mode === "ai_async") {
    throw new SchedulingError("BAD_REQUEST", "An AI first round has no live panel to attend.");
  }
  if (!iv.panel.some((p) => p.membershipId === a.membershipId)) {
    throw new SchedulingError("BAD_REQUEST", "That person is not on this interview's panel.");
  }

  // Validate a named replacement BEFORE writing anything, so a refused swap
  // leaves no half-applied "can't attend" behind.
  if (a.replacementMembershipId) {
    const allowed = await listReplacementCandidates(sql, a.tenantId, a.interviewId);
    if (!allowed.some((c) => c.membershipId === a.replacementMembershipId)) {
      throw new SchedulingError(
        "BAD_REQUEST",
        "The replacement must be an active member of this round's panel pool who is not already on the panel.",
      );
    }
  }

  const [exc] = await sql<{ id: string }[]>`
    INSERT INTO public.panelist_availability_exceptions
      (tenant_id, membership_id, starts_at, ends_at, kind, reason, interview_id,
       created_by_membership_id)
    VALUES (${a.tenantId}, ${a.membershipId}, ${new Date(window.start).toISOString()}::timestamptz, ${new Date(window.end).toISOString()}::timestamptz,
            'cannot_attend', ${a.reason?.trim() || null}, ${a.interviewId}, ${a.actorMembershipId})
    RETURNING id::text
  `;
  if (!exc) throw new Error("exception insert returned no row");

  const info = await loadMemberInfo(sql, a.tenantId, [a.membershipId]);
  const who = info.get(a.membershipId)?.name ?? info.get(a.membershipId)?.email ?? "A panellist";
  const detail = `${who} can no longer attend${a.reason?.trim() ? ` (${a.reason.trim()})` : ""}.`;

  let replacedWith: string | null = null;
  if (a.replacementMembershipId) {
    replacedWith = await swapPanelist(sql, iv, a.membershipId, a.replacementMembershipId);
    const refreshed = await loadInterview(sql, a.tenantId, a.interviewId);
    if (!refreshed) throw new SchedulingError("NOT_FOUND", "Interview not found");
    // Is the new panel free at the original time? Exclude this interview's own
    // booking, which the rest of the panel is (of course) busy with.
    const settings = await loadSchedulingSettings(sql, a.tenantId);
    const config = slotEngineConfigFrom(settings);
    const panelIds = refreshed.panel.map((p) => p.membershipId);
    const panelists = await loadPanelSchedules(sql, a.tenantId, panelIds, window, a.interviewId);
    const extraBusy = await loadCandidateBusy(
      sql,
      a.tenantId,
      iv.row.application_id,
      a.interviewId,
    );
    // Min notice does not apply to keeping an existing booking.
    const stillWorks = isSlotFree(
      {
        panelists,
        durationMinutes: iv.row.duration_minutes,
        config: { ...config, minNoticeHours: 0 },
        now: Math.min(now, window.start),
        extraBusy,
      },
      window.start,
    );
    if (stillWorks) {
      const ctx = await loadCandidateContext(sql, a.tenantId, iv.row.application_id);
      await queuePanelistInvites(sql, {
        tenantId: a.tenantId,
        interviewId: a.interviewId,
        membershipIds: [replacedWith],
        candidateName: ctx?.candidate_name ?? "Candidate",
        companyName: ctx?.company_name ?? "",
        positionTitle: ctx?.position_title ?? "",
        roundName: iv.row.round_name,
        startMs: window.start,
        durationMinutes: iv.row.duration_minutes,
        mode: iv.row.mode,
        meetingUrl: iv.row.meeting_url ?? "",
        timezone: settings.timezone,
      });
      return {
        interviewId: a.interviewId,
        exceptionId: exc.id,
        offerId: null,
        slotsOffered: 0,
        replacedWith,
        recruiterAlerted: false,
      };
    }
    const offer = await reofferForInterview(sql, refreshed, "panelist_unavailable", now);
    if (offer.offerId) {
      await notifyRescheduling(sql, refreshed, null, detail, offer.offerId);
    }
    return {
      interviewId: a.interviewId,
      exceptionId: exc.id,
      offerId: offer.offerId,
      slotsOffered: offer.slots.length,
      replacedWith,
      recruiterAlerted: offer.recruiterAlerted,
    };
  }

  const offer = await reofferForInterview(sql, iv, "panelist_unavailable", now);
  if (offer.offerId) {
    await notifyRescheduling(sql, iv, a.membershipId, detail, offer.offerId);
  }
  return {
    interviewId: a.interviewId,
    exceptionId: exc.id,
    offerId: offer.offerId,
    slotsOffered: offer.slots.length,
    replacedWith: null,
    recruiterAlerted: offer.recruiterAlerted,
  };
}

/** Members of the round's panel pool who are not already on the panel. */
export async function listReplacementCandidates(
  sql: PoolSql,
  tenantId: string,
  interviewId: string,
): Promise<{ membershipId: string; name: string | null }[]> {
  const iv = await loadInterview(sql, tenantId, interviewId);
  if (!iv) throw new SchedulingError("NOT_FOUND", "Interview not found");
  const plan = await loadPlanRound(sql, tenantId, iv.row.requisition_id, iv.row.round_number);
  if (!plan?.panel_pool_id) return [];
  const rows = await sql<{ membership_id: string }[]>`
    SELECT ppm.membership_id::text
    FROM public.panel_pool_members ppm
    JOIN public.tenant_user_memberships tum
      ON tum.tenant_id = ppm.tenant_id AND tum.id = ppm.membership_id AND tum.status = 'active'
    WHERE ppm.tenant_id = ${tenantId} AND ppm.panel_pool_id = ${plan.panel_pool_id}
  `;
  const onPanel = new Set(iv.panel.map((p) => p.membershipId));
  const ids = rows.map((r) => r.membership_id).filter((m) => !onPanel.has(m));
  const info = await loadMemberInfo(sql, tenantId, ids);
  return ids.map((m) => ({
    membershipId: m,
    name: info.get(m)?.name ?? info.get(m)?.email ?? null,
  }));
}

async function swapPanelist(
  sql: PoolSql,
  iv: { row: LiveInterview; panel: { membershipId: string; isLead: boolean }[] },
  outId: string,
  inId: string,
): Promise<string> {
  const allowed = await listReplacementCandidates(sql, iv.row.tenant_id, iv.row.id);
  if (!allowed.some((c) => c.membershipId === inId)) {
    throw new SchedulingError(
      "BAD_REQUEST",
      "The replacement must be an active member of this round's panel pool who is not already on the panel.",
    );
  }
  const wasLead = iv.panel.find((p) => p.membershipId === outId)?.isLead ?? false;
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PoolSql;
    await tx`
      DELETE FROM public.interview_panelists
      WHERE tenant_id = ${iv.row.tenant_id} AND interview_id = ${iv.row.id} AND membership_id = ${outId}
    `;
    await tx`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${iv.row.tenant_id}, ${iv.row.id}, ${inId}, ${wasLead})
    `;
  });
  return inId;
}

/**
 * After an OOO / blocked range is added: every upcoming round of this
 * panellist it overlaps now needs rescheduling, and — unless one is already in
 * flight — the candidate is offered new times automatically.
 */
export async function handleExceptionAdded(
  sql: PoolSql,
  a: { tenantId: string; membershipId: string; startsAt: Date; endsAt: Date; now?: number },
): Promise<{ affected: string[]; reoffered: string[] }> {
  const now = a.now ?? Date.now();
  const rows = await sql<{ id: string }[]>`
    SELECT i.id::text
    FROM public.interviews i
    JOIN public.interview_panelists ip ON ip.tenant_id = i.tenant_id AND ip.interview_id = i.id
    WHERE i.tenant_id = ${a.tenantId} AND ip.membership_id = ${a.membershipId}
      AND i.status = 'scheduled' AND i.mode <> 'ai_async' AND i.scheduled_start IS NOT NULL
      AND i.scheduled_start > ${new Date(now).toISOString()}::timestamptz
      AND i.scheduled_start < ${a.endsAt.toISOString()}::timestamptz
      AND COALESCE(i.scheduled_end, i.scheduled_start + make_interval(mins => i.duration_minutes)) > ${a.startsAt.toISOString()}::timestamptz
  `;
  const affected = rows.map((r) => r.id);
  const reoffered: string[] = [];
  const info = await loadMemberInfo(sql, a.tenantId, [a.membershipId]);
  const who = info.get(a.membershipId)?.name ?? info.get(a.membershipId)?.email ?? "A panellist";
  for (const id of affected) {
    const iv = await loadInterview(sql, a.tenantId, id);
    if (!iv) continue;
    const [open] = await sql<{ id: string }[]>`
      SELECT id FROM public.interview_slot_offers
      WHERE tenant_id = ${a.tenantId} AND application_id = ${iv.row.application_id}
        AND round_number = ${iv.row.round_number} AND status = 'open'
        AND replaces_interview_id = ${id}
      LIMIT 1
    `;
    if (open) continue;
    const offer = await reofferForInterview(sql, iv, "panelist_unavailable", now);
    if (offer.offerId) {
      reoffered.push(id);
      await notifyRescheduling(
        sql,
        iv,
        a.membershipId,
        `${who} is out of office at the booked time.`,
        offer.offerId,
      );
    }
  }
  return { affected, reoffered };
}

/** Upcoming rounds on an application whose current panel has an overlapping exception. */
export async function listNeedsReschedule(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
): Promise<{ interviewId: string; membershipIds: string[]; reasons: string[] }[]> {
  const rows = await sql<
    { interview_id: string; membership_id: string; reason: string | null; kind: string }[]
  >`
    SELECT i.id::text AS interview_id, e.membership_id::text, e.reason, e.kind
    FROM public.interviews i
    JOIN public.interview_panelists ip ON ip.tenant_id = i.tenant_id AND ip.interview_id = i.id
    JOIN public.panelist_availability_exceptions e
      ON e.tenant_id = i.tenant_id AND e.membership_id = ip.membership_id
     AND e.starts_at < COALESCE(i.scheduled_end, i.scheduled_start + make_interval(mins => i.duration_minutes))
     AND e.ends_at > i.scheduled_start
    WHERE i.tenant_id = ${tenantId} AND i.application_id = ${applicationId}
      AND i.status = 'scheduled' AND i.scheduled_start > now()
  `;
  const map = new Map<string, { membershipIds: Set<string>; reasons: string[] }>();
  for (const r of rows) {
    const e = map.get(r.interview_id) ?? { membershipIds: new Set<string>(), reasons: [] };
    e.membershipIds.add(r.membership_id);
    const label =
      r.kind === "cannot_attend"
        ? "Can't attend"
        : r.kind === "out_of_office"
          ? "Out of office"
          : "Blocked";
    e.reasons.push(r.reason ? `${label}: ${r.reason}` : label);
    map.set(r.interview_id, e);
  }
  return [...map.entries()].map(([interviewId, e]) => ({
    interviewId,
    membershipIds: [...e.membershipIds],
    reasons: e.reasons,
  }));
}

/** Candidate-initiated reschedules used so far on a round. */
export async function countCandidateReschedules(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
  roundNumber: number,
): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.interview_slot_offers
    WHERE tenant_id = ${tenantId} AND application_id = ${applicationId}
      AND round_number = ${roundNumber} AND reason = 'candidate_reschedule'
      AND status IN ('open', 'booked', 'expired')
  `;
  return row?.n ?? 0;
}

/** Serialise an offer for the recruiter-side list. */
export function offerRowView(o: OfferRow) {
  return {
    id: o.id,
    roundNumber: Number(o.round_number),
    roundName: o.round_name,
    status: o.status as "open" | "booked" | "expired" | "cancelled" | "superseded",
    reason: o.reason,
    slots: parseSlots(o.slots),
    expiresAt: reqIso(o.expires_at),
    bookedInterviewId: o.booked_interview_id,
    replacesInterviewId: o.replaces_interview_id,
    createdAt: reqIso(o.created_at),
  };
}

export async function listOffersForApplication(
  sql: PoolSql,
  tenantId: string,
  applicationId: string,
): Promise<OfferRow[]> {
  return sql.unsafe<OfferRow[]>(
    `SELECT ${OFFER_COLUMNS} FROM public.interview_slot_offers
     WHERE tenant_id = $1 AND application_id = $2 ORDER BY created_at DESC LIMIT 50`,
    [tenantId, applicationId],
  );
}

// ───────────────────────────── agent port ─────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The worker's `proposeInterviewSlots` port for the propose_calendar_slots
 * agent action — the SAME engine as the recruiter's "Find common slots".
 *
 * `panelRef` is the agent config's free-text `panel_id`: when it is the id of
 * one of the tenant's panel pools, the pool's active members are the panel;
 * otherwise the plan round's default panel is used. With no round given, the
 * first plan round that is not already booked is proposed for.
 */
export async function proposeSlotsForAgent(
  sql: PoolSql,
  tenantId: string,
  req: {
    applicationId: string;
    roundNumber: number | null;
    panelRef: string;
    slotCount: number;
    windowDays: number;
    durationMinutes: number;
  },
): Promise<{
  roundNumber: number | null;
  slots: ProposedSlot[];
  timezone: string;
  emptyReason: string | null;
}> {
  const settings = await loadSchedulingSettings(sql, tenantId);
  let roundNumber = req.roundNumber;
  if (roundNumber === null) {
    const [next] = await sql<{ round_number: number }[]>`
      SELECT p.round_number
      FROM public.interview_plans p
      JOIN public.applications a ON a.tenant_id = p.tenant_id AND a.requisition_id = p.requisition_id
      WHERE p.tenant_id = ${tenantId} AND a.id = ${req.applicationId}
        AND NOT EXISTS (
          SELECT 1 FROM public.interviews i
          WHERE i.tenant_id = p.tenant_id AND i.application_id = a.id
            AND i.round_number = p.round_number AND i.status <> 'cancelled'
        )
      ORDER BY p.round_number LIMIT 1
    `;
    if (!next) {
      return {
        roundNumber: null,
        slots: [],
        timezone: settings.timezone,
        emptyReason:
          "Every interview round on this requisition is already booked (or none is planned).",
      };
    }
    roundNumber = Number(next.round_number);
  }

  let panel: string[] | undefined;
  if (UUID_RE.test(req.panelRef)) {
    const members = await sql<{ membership_id: string }[]>`
      SELECT ppm.membership_id::text
      FROM public.panel_pool_members ppm
      JOIN public.panel_pools pp ON pp.tenant_id = ppm.tenant_id AND pp.id = ppm.panel_pool_id
      JOIN public.tenant_user_memberships tum
        ON tum.tenant_id = ppm.tenant_id AND tum.id = ppm.membership_id AND tum.status = 'active'
      WHERE ppm.tenant_id = ${tenantId} AND ppm.panel_pool_id = ${req.panelRef}
        AND pp.is_archived = false
    `;
    if (members.length > 0) panel = members.map((m) => m.membership_id);
  }

  try {
    const r = await proposeSlotsForRound(sql, tenantId, {
      applicationId: req.applicationId,
      roundNumber,
      durationMinutes: req.durationMinutes,
      panelMembershipIds: panel,
      limit: req.slotCount,
      horizonDaysOverride: req.windowDays,
    });
    return {
      roundNumber,
      slots: r.slots,
      timezone: r.timezone,
      emptyReason: r.emptyReason,
    };
  } catch (err) {
    if (err instanceof SchedulingError && err.code !== "NOT_FOUND") {
      return { roundNumber, slots: [], timezone: settings.timezone, emptyReason: err.message };
    }
    throw err;
  }
}
