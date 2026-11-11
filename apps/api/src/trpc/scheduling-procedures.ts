/**
 * PC-8 / PC-9 / PC-10 — in-app interview scheduling procedures.
 *
 * Kept out of the 31k-line router.ts on purpose and SPREAD into appRouter, so
 * the names stay flat (HANDOVER #31: `proposeInterviewSlots`, not
 * `scheduling.proposeInterviewSlots`). Every rule lives in
 * ../lib/interview-scheduling.ts, which the public pick-a-slot route and the
 * agent worker share; these procedures gate roles, resolve the caller's
 * membership, and hand over.
 *
 * Reads/writes go through ctx.sql (service role) with an explicit tenant_id
 * taken from the verified JWT — the same posture as the N2a consent
 * procedures, and for the same reason (the lib must also serve an
 * unauthenticated route).
 */

import { TRPCError } from "@trpc/server";
import {
  addAvailabilityExceptionInputSchema,
  addAvailabilityExceptionOutputSchema,
  cancelSlotOfferInputSchema,
  cancelSlotOfferOutputSchema,
  candidateGetSlotOfferInputSchema,
  candidateGetSlotOfferOutputSchema,
  candidateListMySlotOffersOutputSchema,
  candidatePickSlotInputSchema,
  candidatePickSlotOutputSchema,
  candidateRequestRescheduleInputSchema,
  candidateRequestRescheduleOutputSchema,
  getPanelistAvailabilityInputSchema,
  getPanelistAvailabilityOutputSchema,
  getSchedulingSettingsInputSchema,
  getSchedulingSettingsOutputSchema,
  hhmmToMinutes,
  listPanelReplacementCandidatesInputSchema,
  listPanelReplacementCandidatesOutputSchema,
  listSlotOffersByApplicationInputSchema,
  listSlotOffersByApplicationOutputSchema,
  markPanelistCannotAttendInputSchema,
  markPanelistCannotAttendOutputSchema,
  minutesToHhmm,
  offerInterviewSlotsInputSchema,
  offerInterviewSlotsOutputSchema,
  proposeInterviewSlotsInputSchema,
  proposeInterviewSlotsOutputSchema,
  removeAvailabilityExceptionInputSchema,
  removeAvailabilityExceptionOutputSchema,
  resolveSchedulingSettings,
  setPanelistAvailabilityWindowsInputSchema,
  setPanelistAvailabilityWindowsOutputSchema,
  updateSchedulingSettingsInputSchema,
  updateSchedulingSettingsOutputSchema,
  type ResolvedSchedulingSettings,
  type ResolvedSchedulingSettingsView,
} from "@hireops/api-types";
import {
  SchedulingError,
  alertRecruiterNoSlots,
  bookOfferSlot,
  candidateOfferView,
  countCandidateReschedules,
  createSlotOffer,
  handleExceptionAdded,
  listNeedsReschedule,
  listOffersForApplication,
  listReplacementCandidates,
  loadInterview,
  loadMemberInfo,
  loadOfferById,
  loadSchedulingSettings,
  markCannotAttend,
  offerRowView,
  proposeSlotsForRound,
  reofferForInterview,
} from "../lib/interview-scheduling";
import { candidateProcedure, protectedProcedure, type HonoTRPCContext } from "./trpc-core";
import { withAudit } from "./with-audit";

/** Recruiter-side scheduling actions — same set as scheduleInterview. */
const INTERVIEW_MANAGE_ROLES = new Set(["admin", "hiring_manager", "recruiter"]);
/** Tenant scheduling settings are an admin configuration surface. */
const SCHEDULING_SETTINGS_ADMIN_ROLES = new Set(["admin"]);
/** Who may see another member's availability. */
const AVAILABILITY_VIEW_OTHERS_ROLES = INTERVIEW_MANAGE_ROLES;
/** Who may edit another member's availability. */
const AVAILABILITY_EDIT_OTHERS_ROLES = new Set(["admin"]);

function hasAnyRole(ctx: HonoTRPCContext, allowed: Set<string>): boolean {
  return ctx.roles.some((r) => allowed.has(r));
}

function requireAnyRole(ctx: HonoTRPCContext, allowed: Set<string>, message: string): void {
  if (!hasAnyRole(ctx, allowed)) throw new TRPCError({ code: "FORBIDDEN", message });
}

function requireTenant(ctx: HonoTRPCContext): string {
  if (!ctx.tenantId) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
  }
  return ctx.tenantId;
}

async function callerMembership(ctx: HonoTRPCContext): Promise<string> {
  const tenantId = requireTenant(ctx);
  const [row] = await ctx.sql<{ id: string }[]>`
    SELECT id::text FROM public.tenant_user_memberships
    WHERE tenant_id = ${tenantId} AND user_id = ${ctx.userId} AND status = 'active'
    LIMIT 1
  `;
  if (!row) throw new TRPCError({ code: "FORBIDDEN", message: "No membership in this tenant" });
  return row.id;
}

/** SchedulingError → TRPCError; everything else passes through. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SchedulingError) {
      throw new TRPCError({ code: err.code, message: err.message });
    }
    throw err;
  }
}

function settingsView(
  s: ResolvedSchedulingSettings,
  override: string | null,
): ResolvedSchedulingSettingsView {
  return {
    timezone: s.timezone,
    timezoneSource: s.timezoneSource,
    timezoneOverride: override,
    durationPresets: s.durationPresets,
    defaultDurationMinutes: s.defaultDurationMinutes,
    workingHoursStart: s.workingHoursStart,
    workingHoursEnd: s.workingHoursEnd,
    workingDays: s.workingDays,
    bufferMinutes: s.bufferMinutes,
    minNoticeHours: s.minNoticeHours,
    slotHorizonDays: s.slotHorizonDays,
    slotIncrementMinutes: s.slotIncrementMinutes,
    maxSlotsOffered: s.maxSlotsOffered,
    offerLinkValidityHours: s.offerLinkValidityHours,
    maxCandidateReschedules: s.maxCandidateReschedules,
    assumeWorkingHoursWhenNoAvailability: s.assumeWorkingHoursWhenNoAvailability,
  };
}

async function readSettingsView(
  ctx: HonoTRPCContext,
  tenantId: string,
): Promise<ResolvedSchedulingSettingsView> {
  const [row] = await ctx.sql<{ settings: unknown }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const block = settings.scheduling as { timezone?: unknown } | undefined;
  const override = typeof block?.timezone === "string" ? block.timezone : null;
  return settingsView(resolveSchedulingSettings(settings), override);
}

/** Target membership for an availability call: self, or another (role-gated). */
async function availabilityTarget(
  ctx: HonoTRPCContext,
  requested: string | undefined,
  mode: "view" | "edit",
): Promise<{ tenantId: string; membershipId: string; isSelf: boolean; actor: string }> {
  const tenantId = requireTenant(ctx);
  const self = await callerMembership(ctx);
  if (!requested || requested === self) {
    return { tenantId, membershipId: self, isSelf: true, actor: self };
  }
  const allowed = mode === "view" ? AVAILABILITY_VIEW_OTHERS_ROLES : AVAILABILITY_EDIT_OTHERS_ROLES;
  requireAnyRole(
    ctx,
    allowed,
    mode === "view"
      ? "Only recruiters, hiring managers and admins can view someone else's availability."
      : "Only admins can edit someone else's availability.",
  );
  const info = await loadMemberInfo(ctx.sql, tenantId, [requested]);
  if (!info.has(requested)) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
  return { tenantId, membershipId: requested, isSelf: false, actor: self };
}

export const schedulingProcedures = {
  // ─────────────────────────── settings ───────────────────────────

  /** Resolved scheduling settings. Any internal user (the schedule flow reads the presets). */
  getSchedulingSettings: protectedProcedure
    .input(getSchedulingSettingsInputSchema)
    .output(getSchedulingSettingsOutputSchema)
    .query(async ({ ctx }) => readSettingsView(ctx, requireTenant(ctx))),

  /**
   * Write `tenants.settings.scheduling` (sibling key, atomic jsonb `||` merge —
   * every other settings block is preserved). Admin-only, audited.
   */
  updateSchedulingSettings: protectedProcedure
    .input(updateSchedulingSettingsInputSchema)
    .output(updateSchedulingSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        SCHEDULING_SETTINGS_ADMIN_ROLES,
        "Only admins can change the scheduling settings.",
      );
      return withAudit("update_scheduling_settings", ctx, input, async () => {
        const tenantId = requireTenant(ctx);
        const updated = await ctx.sql<{ id: string }[]>`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('scheduling', ${JSON.stringify(input)}::jsonb)
          WHERE id = ${tenantId}
          RETURNING id
        `;
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }
        return { ok: true as const, scheduling: await readSettingsView(ctx, tenantId) };
      });
    }),

  // ─────────────────────────── availability ───────────────────────────

  getPanelistAvailability: protectedProcedure
    .input(getPanelistAvailabilityInputSchema)
    .output(getPanelistAvailabilityOutputSchema)
    .query(async ({ ctx, input }) => {
      const t = await availabilityTarget(ctx, input.membershipId, "view");
      const windows = await ctx.sql<
        {
          id: string;
          day_of_week: number;
          start_minute: number;
          end_minute: number;
          timezone: string;
        }[]
      >`
        SELECT id::text, day_of_week, start_minute, end_minute, timezone
        FROM public.panelist_availability_windows
        WHERE tenant_id = ${t.tenantId} AND membership_id = ${t.membershipId}
        ORDER BY day_of_week, start_minute
      `;
      const exceptions = await ctx.sql<
        {
          id: string;
          starts_at: Date | string;
          ends_at: Date | string;
          kind: "blocked" | "out_of_office" | "cannot_attend";
          reason: string | null;
          interview_id: string | null;
        }[]
      >`
        SELECT id::text, starts_at, ends_at, kind, reason, interview_id::text
        FROM public.panelist_availability_exceptions
        WHERE tenant_id = ${t.tenantId} AND membership_id = ${t.membershipId} AND ends_at > now()
        ORDER BY starts_at
      `;
      const info = await loadMemberInfo(ctx.sql, t.tenantId, [t.membershipId]);
      const settings = await loadSchedulingSettings(ctx.sql, t.tenantId);
      const iso = (v: Date | string) => new Date(v).toISOString();
      return {
        membershipId: t.membershipId,
        displayName: info.get(t.membershipId)?.name ?? info.get(t.membershipId)?.email ?? null,
        canEdit: t.isSelf || hasAnyRole(ctx, AVAILABILITY_EDIT_OTHERS_ROLES),
        windows: windows.map((w) => ({
          id: w.id,
          dayOfWeek: Number(w.day_of_week),
          start: minutesToHhmm(Number(w.start_minute)),
          end: minutesToHhmm(Number(w.end_minute)),
          timezone: w.timezone,
        })),
        exceptions: exceptions.map((e) => ({
          id: e.id,
          startsAt: iso(e.starts_at),
          endsAt: iso(e.ends_at),
          kind: e.kind,
          reason: e.reason,
          interviewId: e.interview_id,
        })),
        tenantTimezone: settings.timezone,
      };
    }),

  /** Replace-set of the member's weekly windows. */
  setPanelistAvailabilityWindows: protectedProcedure
    .input(setPanelistAvailabilityWindowsInputSchema)
    .output(setPanelistAvailabilityWindowsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const t = await availabilityTarget(ctx, input.membershipId, "edit");
      return withAudit("set_panelist_availability_windows", ctx, input, async () => {
        await ctx.sql.begin(async (tx) => {
          await tx`
            DELETE FROM public.panelist_availability_windows
            WHERE tenant_id = ${t.tenantId} AND membership_id = ${t.membershipId}
          `;
          for (const w of input.windows) {
            await tx`
              INSERT INTO public.panelist_availability_windows
                (tenant_id, membership_id, day_of_week, start_minute, end_minute, timezone)
              VALUES (${t.tenantId}, ${t.membershipId}, ${w.dayOfWeek}, ${hhmmToMinutes(w.start)},
                      ${hhmmToMinutes(w.end)}, ${w.timezone})
            `;
          }
        });
        return { membershipId: t.membershipId, windowCount: input.windows.length };
      });
    }),

  /**
   * Add a blocked / OOO range. Every upcoming round of this member it overlaps
   * now needs rescheduling, and the candidate is offered new times
   * automatically (PC-10).
   */
  addAvailabilityException: protectedProcedure
    .input(addAvailabilityExceptionInputSchema)
    .output(addAvailabilityExceptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const t = await availabilityTarget(ctx, input.membershipId, "edit");
      return withAudit("add_availability_exception", ctx, input, async () =>
        run(async () => {
          const startsAt = new Date(input.startsAt);
          const endsAt = new Date(input.endsAt);
          const [row] = await ctx.sql<{ id: string }[]>`
            INSERT INTO public.panelist_availability_exceptions
              (tenant_id, membership_id, starts_at, ends_at, kind, reason, created_by_membership_id)
            VALUES (${t.tenantId}, ${t.membershipId}, ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, ${input.kind},
                    ${input.reason?.trim() || null}, ${t.actor})
            RETURNING id::text
          `;
          if (!row) throw new Error("exception insert returned no row");
          const { affected, reoffered } = await handleExceptionAdded(ctx.sql, {
            tenantId: t.tenantId,
            membershipId: t.membershipId,
            startsAt,
            endsAt,
          });
          return {
            exceptionId: row.id,
            affectedInterviewIds: affected,
            reofferedInterviewIds: reoffered,
          };
        }),
      );
    }),

  removeAvailabilityException: protectedProcedure
    .input(removeAvailabilityExceptionInputSchema)
    .output(removeAvailabilityExceptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenant(ctx);
      const self = await callerMembership(ctx);
      return withAudit("remove_availability_exception", ctx, input, async () => {
        const [row] = await ctx.sql<{ membership_id: string; kind: string }[]>`
          SELECT membership_id::text, kind FROM public.panelist_availability_exceptions
          WHERE tenant_id = ${tenantId} AND id = ${input.exceptionId}
        `;
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
        if (row.membership_id !== self && !hasAnyRole(ctx, AVAILABILITY_EDIT_OTHERS_ROLES)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not your availability." });
        }
        await ctx.sql`
          DELETE FROM public.panelist_availability_exceptions
          WHERE tenant_id = ${tenantId} AND id = ${input.exceptionId}
        `;
        return { ok: true as const };
      });
    }),

  // ─────────────────────────── proposal + offers ───────────────────────────

  /**
   * PC-8 — ranked common slots for a round. With none, the reason is returned
   * and the requisition's recruiter is alerted (email, de-duplicated per day).
   */
  proposeInterviewSlots: protectedProcedure
    .input(proposeInterviewSlotsInputSchema)
    .output(proposeInterviewSlotsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, INTERVIEW_MANAGE_ROLES, "You don't have access to interview scheduling.");
      const tenantId = requireTenant(ctx);
      return run(async () => {
        const r = await proposeSlotsForRound(ctx.sql, tenantId, input);
        let recruiterAlerted = false;
        if (r.slots.length === 0 && r.panel.length > 0) {
          recruiterAlerted = await alertRecruiterNoSlots(
            ctx.sql,
            tenantId,
            input.applicationId,
            input.roundNumber,
            r.roundName,
            r.emptyReason ?? "",
          );
        }
        return {
          slots: r.slots,
          totalFree: r.totalFree,
          durationMinutes: r.durationMinutes,
          timezone: r.timezone,
          panel: r.panel,
          emptyReason: r.emptyReason,
          recruiterAlerted,
        };
      });
    }),

  /** PC-9 — "Let the candidate choose": store an offer and email the pick link. */
  offerInterviewSlots: protectedProcedure
    .input(offerInterviewSlotsInputSchema)
    .output(offerInterviewSlotsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only hiring managers, recruiters and admins can offer interview slots.",
      );
      const tenantId = requireTenant(ctx);
      const actor = await callerMembership(ctx);
      return withAudit("offer_interview_slots", ctx, input, async () =>
        run(() =>
          createSlotOffer(ctx.sql, {
            tenantId,
            applicationId: input.applicationId,
            roundNumber: input.roundNumber,
            panelMembershipIds: input.panelMembershipIds,
            leadMembershipId: input.leadMembershipId ?? null,
            durationMinutes: input.durationMinutes,
            mode: input.mode,
            meetingUrl: input.meetingUrl ?? null,
            slotStarts: input.slotStarts,
            reason: "initial",
            createdByMembershipId: actor,
          }),
        ),
      );
    }),

  listSlotOffersByApplication: protectedProcedure
    .input(listSlotOffersByApplicationInputSchema)
    .output(listSlotOffersByApplicationOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, INTERVIEW_MANAGE_ROLES, "You don't have access to interviews.");
      const tenantId = requireTenant(ctx);
      const rows = await listOffersForApplication(ctx.sql, tenantId, input.applicationId);
      const needsReschedule = await listNeedsReschedule(ctx.sql, tenantId, input.applicationId);
      return { items: rows.map(offerRowView), needsReschedule };
    }),

  cancelSlotOffer: protectedProcedure
    .input(cancelSlotOfferInputSchema)
    .output(cancelSlotOfferOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(ctx, INTERVIEW_MANAGE_ROLES, "You don't have access to interviews.");
      const tenantId = requireTenant(ctx);
      return withAudit("cancel_slot_offer", ctx, input, async () => {
        const rows = await ctx.sql<{ id: string }[]>`
          UPDATE public.interview_slot_offers SET status = 'cancelled', updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${input.offerId} AND status = 'open'
          RETURNING id
        `;
        if (rows.length === 0) {
          const offer = await loadOfferById(ctx.sql, tenantId, input.offerId);
          if (!offer) throw new TRPCError({ code: "NOT_FOUND", message: "Offer not found" });
        }
        return { ok: true as const };
      });
    }),

  // ─────────────────────────── can't attend (PC-10) ───────────────────────────

  /**
   * A panellist can't attend an upcoming round. The panellist marks it for
   * themselves; a recruiter / HM / admin may mark it on their behalf and may
   * name a replacement from the round's panel pool.
   */
  markPanelistCannotAttend: protectedProcedure
    .input(markPanelistCannotAttendInputSchema)
    .output(markPanelistCannotAttendOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = requireTenant(ctx);
      const self = await callerMembership(ctx);
      const target = input.membershipId ?? self;
      const isManager = hasAnyRole(ctx, INTERVIEW_MANAGE_ROLES);
      if (target !== self && !isManager) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only recruiters, hiring managers and admins can act for another panellist.",
        });
      }
      if (input.replacementMembershipId && !isManager) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only recruiters, hiring managers and admins can swap a panellist.",
        });
      }
      return withAudit("mark_panelist_cannot_attend", ctx, input, async () =>
        run(() =>
          markCannotAttend(ctx.sql, {
            tenantId,
            interviewId: input.interviewId,
            membershipId: target,
            reason: input.reason ?? null,
            replacementMembershipId: input.replacementMembershipId ?? null,
            actorMembershipId: self,
          }),
        ),
      );
    }),

  listPanelReplacementCandidates: protectedProcedure
    .input(listPanelReplacementCandidatesInputSchema)
    .output(listPanelReplacementCandidatesOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, INTERVIEW_MANAGE_ROLES, "You don't have access to interviews.");
      const tenantId = requireTenant(ctx);
      return run(async () => ({
        items: await listReplacementCandidates(ctx.sql, tenantId, input.interviewId),
      }));
    }),

  // ─────────────────────────── candidate portal (PC-9) ───────────────────────────

  /** The caller's open offers (person-scoped) + reschedules left per upcoming round. */
  candidateListMySlotOffers: candidateProcedure
    .output(candidateListMySlotOffersOutputSchema)
    .query(async ({ ctx }) => {
      const { tenantId, personId } = ctx.candidate;
      const offers = await ctx.sql<{ id: string }[]>`
        SELECT o.id::text
        FROM public.interview_slot_offers o
        JOIN public.applications a ON a.tenant_id = o.tenant_id AND a.id = o.application_id
        JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
        WHERE o.tenant_id = ${tenantId} AND c.person_id = ${personId} AND o.status = 'open'
        ORDER BY o.created_at DESC
      `;
      const items = [];
      for (const o of offers) {
        const row = await loadOfferById(ctx.sql, tenantId, o.id);
        if (!row) continue;
        const view = await candidateOfferView(ctx.sql, row);
        if (view.status === "open") items.push(view);
      }
      const upcoming = await ctx.sql<
        { id: string; application_id: string; round_number: number }[]
      >`
        SELECT i.id::text, i.application_id::text, i.round_number
        FROM public.interviews i
        JOIN public.applications a ON a.tenant_id = i.tenant_id AND a.id = i.application_id
        JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
        WHERE i.tenant_id = ${tenantId} AND c.person_id = ${personId}
          AND i.status = 'scheduled' AND i.scheduled_start > now()
      `;
      const settings = await loadSchedulingSettings(ctx.sql, tenantId);
      const reschedulesRemaining: Record<string, number> = {};
      for (const iv of upcoming) {
        const used = await countCandidateReschedules(
          ctx.sql,
          tenantId,
          iv.application_id,
          Number(iv.round_number),
        );
        reschedulesRemaining[iv.id] = Math.max(0, settings.maxCandidateReschedules - used);
      }
      return { items, reschedulesRemaining };
    }),

  candidateGetSlotOffer: candidateProcedure
    .input(candidateGetSlotOfferInputSchema)
    .output(candidateGetSlotOfferOutputSchema)
    .query(async ({ ctx, input }) => {
      const row = await ownedOffer(ctx.sql, ctx.candidate, input.offerId);
      return candidateOfferView(ctx.sql, row);
    }),

  /**
   * "Reschedule" from the candidate portal: re-offer slots for an upcoming
   * round, within the tenant's per-round allowance. The current booking stands
   * until a new time is picked. An open offer for the round is returned as-is
   * (asking twice must not burn the allowance twice).
   */
  candidateRequestReschedule: candidateProcedure
    .input(candidateRequestRescheduleInputSchema)
    .output(candidateRequestRescheduleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const { tenantId, personId } = ctx.candidate;
      return withAudit("candidate_request_reschedule", ctx, input, async () =>
        run(async () => {
          const [owned] = await ctx.sql<{ id: string }[]>`
            SELECT i.id::text FROM public.interviews i
            JOIN public.applications a ON a.tenant_id = i.tenant_id AND a.id = i.application_id
            JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
            WHERE i.tenant_id = ${tenantId} AND i.id = ${input.interviewId}
              AND c.person_id = ${personId}
          `;
          if (!owned) throw new TRPCError({ code: "NOT_FOUND", message: "interview_not_found" });
          const iv = await loadInterview(ctx.sql, tenantId, input.interviewId);
          if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "interview_not_found" });
          const startMs = iv.row.scheduled_start ? new Date(iv.row.scheduled_start).getTime() : 0;
          if (iv.row.status !== "scheduled" || startMs <= Date.now()) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Only an upcoming interview can be rescheduled.",
            });
          }
          if (iv.row.mode === "ai_async") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This round is taken in your own time — there is nothing to reschedule.",
            });
          }
          const settings = await loadSchedulingSettings(ctx.sql, tenantId);
          const used = await countCandidateReschedules(
            ctx.sql,
            tenantId,
            iv.row.application_id,
            iv.row.round_number,
          );

          const [open] = await ctx.sql<{ id: string }[]>`
            SELECT id::text FROM public.interview_slot_offers
            WHERE tenant_id = ${tenantId} AND application_id = ${iv.row.application_id}
              AND round_number = ${iv.row.round_number} AND status = 'open'
              AND replaces_interview_id = ${iv.row.id}
            LIMIT 1
          `;
          if (open) {
            const row = await loadOfferById(ctx.sql, tenantId, open.id);
            const view = row ? await candidateOfferView(ctx.sql, row) : null;
            if (view && view.status === "open") {
              return {
                offerId: view.offerId,
                slots: view.slots,
                remainingReschedules: Math.max(0, settings.maxCandidateReschedules - used),
                message: null,
              };
            }
          }

          if (used >= settings.maxCandidateReschedules) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "You've reached the number of reschedules allowed for this round. Please contact your recruiter.",
            });
          }
          const offer = await reofferForInterview(ctx.sql, iv, "candidate_reschedule");
          return {
            offerId: offer.offerId,
            slots: offer.slots,
            remainingReschedules: Math.max(
              0,
              settings.maxCandidateReschedules - used - (offer.offerId ? 1 : 0),
            ),
            message: offer.offerId
              ? null
              : "We couldn't find another time right now. Your recruiter has been told and will be in touch; your current time still stands.",
          };
        }),
      );
    }),

  candidatePickSlot: candidateProcedure
    .input(candidatePickSlotInputSchema)
    .output(candidatePickSlotOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await ownedOffer(ctx.sql, ctx.candidate, input.offerId);
      return withAudit("candidate_pick_slot", ctx, input, async () => {
        const res = await bookOfferSlot(ctx.sql, {
          by: { tenantId: row.tenant_id, offerId: row.id },
          slotStart: input.slotStart,
          via: "candidate_portal",
          ip: ctx.ipAddress,
        });
        if (!res.ok) {
          throw new TRPCError({
            code: res.reason === "slot_not_offered" ? "BAD_REQUEST" : "CONFLICT",
            message: res.reason,
          });
        }
        return { interviewId: res.interviewId, scheduledStart: res.scheduledStart };
      });
    }),
};

/** Load an offer only if it belongs to THIS candidate's person (opaque NOT_FOUND otherwise). */
async function ownedOffer(
  sql: HonoTRPCContext["sql"],
  candidate: { tenantId: string; personId: string },
  offerId: string,
) {
  const [owned] = await sql<{ id: string }[]>`
    SELECT o.id::text FROM public.interview_slot_offers o
    JOIN public.applications a ON a.tenant_id = o.tenant_id AND a.id = o.application_id
    JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    WHERE o.tenant_id = ${candidate.tenantId} AND o.id = ${offerId}
      AND c.person_id = ${candidate.personId}
  `;
  const row = owned ? await loadOfferById(sql, candidate.tenantId, offerId) : null;
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "offer_not_found" });
  return row;
}
