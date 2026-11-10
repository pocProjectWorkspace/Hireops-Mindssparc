import { z } from "zod";
import { hhmmToMinutes, isValidTimeZone, type SlotEngineConfig } from "./scheduling-slots";

/**
 * PC-8 / PC-9 / PC-10 — in-app interview scheduling contracts.
 *
 * TENANT SETTINGS. Persisted to `tenants.settings.scheduling` (a SIBLING of
 * slaThresholds / retentionPolicy — no migration). Platform default + tenant
 * override: an unconfigured tenant resolves to `defaultSchedulingSettings()`,
 * and nothing in the defaults is client-specific. In particular the platform
 * default TIME ZONE is UTC; the resolver uses the block's own `timezone`, else
 * a tenant-wide `settings.timezone` if the tenant has one, else UTC.
 */

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM (24-hour)")
  .refine((v) => !Number.isNaN(hhmmToMinutes(v)), "Use HH:MM (24-hour)");

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => isValidTimeZone(v), "Unknown time zone (use an IANA name, e.g. Europe/Berlin)");

const durationPreset = z.number().int().min(15).max(480);

/** The platform's fallback zone. Deliberately UTC — never a client's zone. */
export const PLATFORM_DEFAULT_TIMEZONE = "UTC";

export const schedulingSettingsSchema = z
  .object({
    /** IANA zone for the working window + slot grid. null = tenant settings.timezone, else UTC. */
    timezone: timeZone.nullable().default(null),
    /** Duration chips offered in the schedule flow. */
    durationPresets: z.array(durationPreset).min(1).max(6).default([30, 45, 60]),
    defaultDurationMinutes: durationPreset.default(45),
    /** Working window (tenant local time). */
    workingHoursStart: hhmm.default("09:00"),
    workingHoursEnd: hhmm.default("18:00"),
    /** 0 = Sunday … 6 = Saturday. */
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
    /** Air kept either side of an existing interview. */
    bufferMinutes: z.number().int().min(0).max(240).default(15),
    /** No slot earlier than this many hours from now. */
    minNoticeHours: z.number().int().min(0).max(336).default(24),
    /** No slot later than this many days from now. */
    slotHorizonDays: z.number().int().min(1).max(90).default(14),
    /** Slot-start grid. */
    slotIncrementMinutes: z.number().int().min(5).max(120).default(30),
    /** How many slots a candidate is offered at most. */
    maxSlotsOffered: z.number().int().min(1).max(20).default(5),
    /** Lifetime of the candidate's pick-a-slot link. */
    offerLinkValidityHours: z.number().int().min(1).max(720).default(72),
    /** Candidate-initiated reschedules allowed per round. */
    maxCandidateReschedules: z.number().int().min(0).max(10).default(2),
    /**
     * When a panellist has entered NO weekly availability, treat them as free
     * during the working window. Off by default: without it the engine never
     * invents availability for someone who has not declared any.
     */
    assumeWorkingHoursWhenNoAvailability: z.boolean().default(false),
  })
  .refine((v) => hhmmToMinutes(v.workingHoursEnd) > hhmmToMinutes(v.workingHoursStart), {
    message: "Working hours must end after they start",
    path: ["workingHoursEnd"],
  })
  .refine((v) => v.durationPresets.includes(v.defaultDurationMinutes), {
    message: "The default duration must be one of the presets",
    path: ["defaultDurationMinutes"],
  });
export type SchedulingSettings = z.infer<typeof schedulingSettingsSchema>;

/** Resolved settings: always a concrete zone, plus where that zone came from. */
export type ResolvedSchedulingSettings = Omit<SchedulingSettings, "timezone"> & {
  timezone: string;
  timezoneSource: "scheduling" | "tenant" | "platform";
};

export function defaultSchedulingSettings(): SchedulingSettings {
  return schedulingSettingsSchema.parse({});
}

/**
 * Merge a stored `settings` object (the WHOLE tenants.settings jsonb) into the
 * resolved scheduling settings. Never throws: a malformed `scheduling` block
 * falls back to the defaults wholesale (the resolveRetentionPolicy posture).
 */
export function resolveSchedulingSettings(tenantSettings: unknown): ResolvedSchedulingSettings {
  const settings =
    tenantSettings && typeof tenantSettings === "object"
      ? (tenantSettings as Record<string, unknown>)
      : {};
  const parsed = schedulingSettingsSchema.safeParse(settings.scheduling ?? {});
  const s = parsed.success ? parsed.data : defaultSchedulingSettings();
  const tenantTz =
    typeof settings.timezone === "string" && isValidTimeZone(settings.timezone)
      ? settings.timezone
      : null;
  if (s.timezone) return { ...s, timezone: s.timezone, timezoneSource: "scheduling" };
  if (tenantTz) return { ...s, timezone: tenantTz, timezoneSource: "tenant" };
  return { ...s, timezone: PLATFORM_DEFAULT_TIMEZONE, timezoneSource: "platform" };
}

/** Resolved settings → the slot engine's config. */
export function slotEngineConfigFrom(s: ResolvedSchedulingSettings): SlotEngineConfig {
  return {
    timezone: s.timezone,
    workingHours: {
      startMinute: hhmmToMinutes(s.workingHoursStart),
      endMinute: hhmmToMinutes(s.workingHoursEnd),
    },
    workingDays: s.workingDays,
    assumeWorkingHoursWhenNoAvailability: s.assumeWorkingHoursWhenNoAvailability,
    bufferMinutes: s.bufferMinutes,
    minNoticeHours: s.minNoticeHours,
    horizonDays: s.slotHorizonDays,
    slotIncrementMinutes: s.slotIncrementMinutes,
  };
}

// ─────────────────────────── settings procedures ───────────────────────────

export const resolvedSchedulingSettingsSchema = z.object({
  timezone: z.string(),
  timezoneSource: z.enum(["scheduling", "tenant", "platform"]),
  /** The stored override (null = inherit). Lets the admin page show "inherited". */
  timezoneOverride: z.string().nullable(),
  durationPresets: z.array(z.number().int()),
  defaultDurationMinutes: z.number().int(),
  workingHoursStart: z.string(),
  workingHoursEnd: z.string(),
  workingDays: z.array(z.number().int()),
  bufferMinutes: z.number().int(),
  minNoticeHours: z.number().int(),
  slotHorizonDays: z.number().int(),
  slotIncrementMinutes: z.number().int(),
  maxSlotsOffered: z.number().int(),
  offerLinkValidityHours: z.number().int(),
  maxCandidateReschedules: z.number().int(),
  assumeWorkingHoursWhenNoAvailability: z.boolean(),
});
export type ResolvedSchedulingSettingsView = z.infer<typeof resolvedSchedulingSettingsSchema>;

export const getSchedulingSettingsInputSchema = z.object({});
export const getSchedulingSettingsOutputSchema = resolvedSchedulingSettingsSchema;
export type GetSchedulingSettingsOutput = z.infer<typeof getSchedulingSettingsOutputSchema>;

export const updateSchedulingSettingsInputSchema = schedulingSettingsSchema;
export type UpdateSchedulingSettingsInput = z.input<typeof updateSchedulingSettingsInputSchema>;
export const updateSchedulingSettingsOutputSchema = z.object({
  ok: z.literal(true),
  scheduling: resolvedSchedulingSettingsSchema,
});

// ─────────────────────────── availability ───────────────────────────

export const availabilityWindowSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    start: hhmm,
    end: hhmm,
    timezone: timeZone,
  })
  .refine((w) => hhmmToMinutes(w.end) > hhmmToMinutes(w.start), {
    message: "A window must end after it starts",
    path: ["end"],
  });
export type AvailabilityWindowInput = z.infer<typeof availabilityWindowSchema>;

export const availabilityExceptionKindSchema = z.enum([
  "blocked",
  "out_of_office",
  "cannot_attend",
]);

export const availabilityExceptionRowSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  kind: availabilityExceptionKindSchema,
  reason: z.string().nullable(),
  interviewId: z.string().uuid().nullable(),
});
export type AvailabilityExceptionRow = z.infer<typeof availabilityExceptionRowSchema>;

export const getPanelistAvailabilityInputSchema = z.object({
  /** Omit for "mine". Viewing someone else requires recruiter / HM / admin. */
  membershipId: z.string().uuid().optional(),
});
export const getPanelistAvailabilityOutputSchema = z.object({
  membershipId: z.string().uuid(),
  displayName: z.string().nullable(),
  canEdit: z.boolean(),
  windows: z.array(
    z.object({
      id: z.string().uuid(),
      dayOfWeek: z.number().int(),
      start: z.string(),
      end: z.string(),
      timezone: z.string(),
    }),
  ),
  /** Exceptions ending in the future (past ones are history, not availability). */
  exceptions: z.array(availabilityExceptionRowSchema),
  /** The tenant zone, to prefill a first window. */
  tenantTimezone: z.string(),
});
export type GetPanelistAvailabilityOutput = z.infer<typeof getPanelistAvailabilityOutputSchema>;

export const setPanelistAvailabilityWindowsInputSchema = z.object({
  membershipId: z.string().uuid().optional(),
  /** Replace-set. */
  windows: z.array(availabilityWindowSchema).max(50),
});
export const setPanelistAvailabilityWindowsOutputSchema = z.object({
  membershipId: z.string().uuid(),
  windowCount: z.number().int(),
});

export const addAvailabilityExceptionInputSchema = z
  .object({
    membershipId: z.string().uuid().optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    kind: z.enum(["blocked", "out_of_office"]).default("out_of_office"),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => new Date(v.endsAt).getTime() > new Date(v.startsAt).getTime(), {
    message: "The range must end after it starts",
    path: ["endsAt"],
  });
export const addAvailabilityExceptionOutputSchema = z.object({
  exceptionId: z.string().uuid(),
  /** Upcoming interviews of this panellist that the new range overlaps — each now needs rescheduling. */
  affectedInterviewIds: z.array(z.string().uuid()),
  /** Offers automatically sent to candidates for those interviews. */
  reofferedInterviewIds: z.array(z.string().uuid()),
});

export const removeAvailabilityExceptionInputSchema = z.object({
  exceptionId: z.string().uuid(),
});
export const removeAvailabilityExceptionOutputSchema = z.object({ ok: z.literal(true) });

// ─────────────────────────── slot proposal ───────────────────────────

export const proposedSlotSchema = z.object({ start: z.string(), end: z.string() });
export type ProposedSlotView = z.infer<typeof proposedSlotSchema>;

export const proposeInterviewSlotsInputSchema = z.object({
  applicationId: z.string().uuid(),
  roundNumber: z.number().int().min(1).max(20),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  /** Omit to use the plan round's default panel. */
  panelMembershipIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  /** Defaults to the tenant's maxSlotsOffered. */
  limit: z.number().int().min(1).max(50).optional(),
});
export type ProposeInterviewSlotsInput = z.infer<typeof proposeInterviewSlotsInputSchema>;

export const panelistAvailabilityStateSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string().nullable(),
  /** false → this panellist has declared no weekly availability. */
  hasAvailability: z.boolean(),
});

export const proposeInterviewSlotsOutputSchema = z.object({
  slots: z.array(proposedSlotSchema),
  totalFree: z.number().int(),
  durationMinutes: z.number().int(),
  timezone: z.string(),
  panel: z.array(panelistAvailabilityStateSchema),
  /** Human-readable reason when `slots` is empty. */
  emptyReason: z.string().nullable(),
  /** True when an in-app/email alert was raised to the recruiter for an empty result. */
  recruiterAlerted: z.boolean(),
});
export type ProposeInterviewSlotsOutput = z.infer<typeof proposeInterviewSlotsOutputSchema>;

// ─────────────────────────── offers (PC-9) ───────────────────────────

export const slotOfferStatusSchema = z.enum([
  "open",
  "booked",
  "expired",
  "cancelled",
  "superseded",
]);
export const slotOfferReasonSchema = z.enum([
  "initial",
  "candidate_reschedule",
  "panelist_unavailable",
  "recruiter_reschedule",
]);

export const offerInterviewSlotsInputSchema = z
  .object({
    applicationId: z.string().uuid(),
    roundNumber: z.number().int().min(1).max(20),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    mode: z.enum(["video", "onsite", "phone"]).optional(),
    meetingUrl: z.string().url().max(2000).optional(),
    panelMembershipIds: z.array(z.string().uuid()).min(1).max(20),
    leadMembershipId: z.string().uuid().optional(),
    /** Optional subset of proposed slot starts to offer; omit to offer the top N. */
    slotStarts: z
      .array(z.string().datetime({ offset: true }))
      .min(1)
      .max(20)
      .optional(),
  })
  .refine((v) => !v.leadMembershipId || v.panelMembershipIds.includes(v.leadMembershipId), {
    message: "leadMembershipId must be one of panelMembershipIds",
    path: ["leadMembershipId"],
  });
export type OfferInterviewSlotsInput = z.infer<typeof offerInterviewSlotsInputSchema>;

export const offerInterviewSlotsOutputSchema = z.object({
  offerId: z.string().uuid().nullable(),
  slots: z.array(proposedSlotSchema),
  expiresAt: z.string().nullable(),
  sentTo: z.string().nullable(),
  /** Set when no slot could be offered. */
  emptyReason: z.string().nullable(),
  recruiterAlerted: z.boolean(),
});
export type OfferInterviewSlotsOutput = z.infer<typeof offerInterviewSlotsOutputSchema>;

export const slotOfferRowSchema = z.object({
  id: z.string().uuid(),
  roundNumber: z.number().int(),
  roundName: z.string(),
  status: slotOfferStatusSchema,
  reason: slotOfferReasonSchema,
  slots: z.array(proposedSlotSchema),
  expiresAt: z.string(),
  bookedInterviewId: z.string().uuid().nullable(),
  replacesInterviewId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type SlotOfferRow = z.infer<typeof slotOfferRowSchema>;

export const listSlotOffersByApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const listSlotOffersByApplicationOutputSchema = z.object({
  items: z.array(slotOfferRowSchema),
  /** Upcoming interviews on this application whose panel has a conflict. */
  needsReschedule: z.array(
    z.object({
      interviewId: z.string().uuid(),
      membershipIds: z.array(z.string().uuid()),
      reasons: z.array(z.string()),
    }),
  ),
});

export const cancelSlotOfferInputSchema = z.object({ offerId: z.string().uuid() });
export const cancelSlotOfferOutputSchema = z.object({ ok: z.literal(true) });

// ─────────────────────────── can't attend (PC-10) ───────────────────────────

export const markPanelistCannotAttendInputSchema = z.object({
  interviewId: z.string().uuid(),
  /** Omit for "me". A recruiter / HM / admin may mark on a panellist's behalf. */
  membershipId: z.string().uuid().optional(),
  reason: z.string().trim().max(500).optional(),
  /** Optional replacement from the same panel pool (recruiter-only). */
  replacementMembershipId: z.string().uuid().optional(),
});
export const markPanelistCannotAttendOutputSchema = z.object({
  interviewId: z.string().uuid(),
  exceptionId: z.string().uuid(),
  /** The new offer sent to the candidate, or null when no slot could be found. */
  offerId: z.string().uuid().nullable(),
  slotsOffered: z.number().int(),
  replacedWith: z.string().uuid().nullable(),
  recruiterAlerted: z.boolean(),
});

export const listPanelReplacementCandidatesInputSchema = z.object({
  interviewId: z.string().uuid(),
});
export const listPanelReplacementCandidatesOutputSchema = z.object({
  items: z.array(z.object({ membershipId: z.string().uuid(), name: z.string().nullable() })),
});

// ─────────────────────────── candidate side ───────────────────────────

/** What the public pick page and the candidate portal render. */
export const candidateSlotOfferViewSchema = z.object({
  offerId: z.string().uuid(),
  status: slotOfferStatusSchema,
  candidateName: z.string(),
  companyName: z.string(),
  positionTitle: z.string(),
  roundName: z.string(),
  durationMinutes: z.number().int(),
  mode: z.string(),
  reason: slotOfferReasonSchema,
  expiresAt: z.string(),
  /** The upcoming round this offer would replace (reschedules), else null. */
  replacesInterviewId: z.string().uuid().nullable(),
  /** Slots still free right now (re-checked on every read). */
  slots: z.array(proposedSlotSchema),
  bookedSlotStart: z.string().nullable(),
});
export type CandidateSlotOfferView = z.infer<typeof candidateSlotOfferViewSchema>;

export const candidateRequestRescheduleInputSchema = z.object({ interviewId: z.string().uuid() });
export const candidateRequestRescheduleOutputSchema = z.object({
  offerId: z.string().uuid().nullable(),
  slots: z.array(proposedSlotSchema),
  remainingReschedules: z.number().int(),
  /** Set when no new times could be offered (the recruiter has been alerted). */
  message: z.string().nullable(),
});

export const candidateGetSlotOfferInputSchema = z.object({ offerId: z.string().uuid() });
export const candidateGetSlotOfferOutputSchema = candidateSlotOfferViewSchema;

export const candidatePickSlotInputSchema = z.object({
  offerId: z.string().uuid(),
  slotStart: z.string().datetime({ offset: true }),
});
export const candidatePickSlotOutputSchema = z.object({
  interviewId: z.string().uuid(),
  scheduledStart: z.string(),
});

export const candidateListMySlotOffersOutputSchema = z.object({
  items: z.array(candidateSlotOfferViewSchema),
  /** Interview id → candidate reschedules remaining for that round. */
  reschedulesRemaining: z.record(z.string(), z.number().int()),
});
