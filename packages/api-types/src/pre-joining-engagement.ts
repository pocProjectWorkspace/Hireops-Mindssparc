import { z } from "zod";

/**
 * PC-14..17 — pre-joining (notice-period) candidate engagement.
 *
 * Pure contracts + pure logic shared by the API (journey creation, pulse
 * route, inbound webhook, watchlist), the worker drain (sending due
 * touchpoints) and the admin + recruiter surfaces. No db, no io.
 *
 * PLATFORM FEATURE, TENANT SETTINGS. Everything tenant-variable lives in
 * `tenants.settings.preJoiningEngagement` (a sibling of retentionPolicy /
 * slaThresholds — no table). An unconfigured tenant resolves to the platform
 * defaults below, and the platform default is `enabled: false`: a tenant opts
 * in, nothing is sent to a candidate of a tenant that has not.
 *
 * FACTS, NOT SCORES. The engagement surfaces show what happened — touchpoints
 * sent, answers given, the candidate's own words. A "risk signal" is a named
 * thing the candidate SAID (from a fixed platform vocabulary) backed by a
 * VERBATIM quote, or a pulse answer they gave. There is deliberately no
 * overall flight-risk score, no probability and no inference about the person
 * (personality, sentiment, demographic or otherwise). See CLAUDE.md "Product
 * stances".
 */

// ─────────────────────────── journey steps ───────────────────────────

export const PRE_JOINING_STEP_KEYS = [
  "welcome",
  "pulse",
  "company_update",
  "two_weeks_to_go",
  "one_week_to_go",
] as const;
export const preJoiningStepKeySchema = z.enum(PRE_JOINING_STEP_KEYS);
export type PreJoiningStepKey = z.infer<typeof preJoiningStepKeySchema>;

export const PRE_JOINING_STEP_LABELS: Record<PreJoiningStepKey, string> = {
  welcome: "Welcome (on accept)",
  pulse: "Check-in pulse",
  company_update: "Company update",
  two_weeks_to_go: "Two weeks to go",
  one_week_to_go: "One week to go (first-day info)",
};

/** Steps whose email carries the "are you still on track?" check-in link. */
export const PULSE_CARRYING_STEPS: ReadonlySet<PreJoiningStepKey> = new Set([
  "pulse",
  "two_weeks_to_go",
]);

// ─────────────────────────── risk signals ───────────────────────────

/**
 * The fixed platform vocabulary the reply classifier may use. A tenant can
 * switch types off or choose which alert, but cannot invent new ones — the
 * classifier prompt, the CHECK constraint (0128) and this list move together.
 */
export const CLASSIFIER_SIGNAL_TYPES = [
  "other_offer",
  "counter_offer",
  "joining_date_change",
  "doubt_or_hesitation",
  "notice_period_issue",
  "withdrawing",
] as const;

/** Signals raised by a pulse answer rather than by the classifier. */
export const PULSE_SIGNAL_TYPES = ["pulse_unsure", "pulse_not_on_track"] as const;

export const RISK_SIGNAL_TYPES = [...CLASSIFIER_SIGNAL_TYPES, ...PULSE_SIGNAL_TYPES] as const;
export const classifierSignalTypeSchema = z.enum(CLASSIFIER_SIGNAL_TYPES);
export type ClassifierSignalType = z.infer<typeof classifierSignalTypeSchema>;
export const riskSignalTypeSchema = z.enum(RISK_SIGNAL_TYPES);
export type RiskSignalType = z.infer<typeof riskSignalTypeSchema>;

export const RISK_SIGNAL_LABELS: Record<RiskSignalType, string> = {
  other_offer: "Mentions another offer",
  counter_offer: "Mentions a counter-offer",
  joining_date_change: "Joining date change",
  doubt_or_hesitation: "Expresses doubt",
  notice_period_issue: "Notice-period issue",
  withdrawing: "Says they are withdrawing",
  pulse_unsure: "Pulse: unsure",
  pulse_not_on_track: "Pulse: not on track",
};

/** One-line definitions — shown in the admin UI AND given to the classifier. */
export const CLASSIFIER_SIGNAL_DEFINITIONS: Record<ClassifierSignalType, string> = {
  other_offer: "The candidate says they have, or are considering, an offer from another employer.",
  counter_offer:
    "The candidate says their current employer has made, or may make, a counter-offer to keep them.",
  joining_date_change:
    "The candidate asks to move their joining date, or says they cannot join on the agreed date.",
  doubt_or_hesitation:
    "The candidate explicitly says they are unsure, having second thoughts, or reconsidering joining.",
  notice_period_issue:
    "The candidate reports a problem with serving or shortening their notice period (e.g. release not granted, buyout refused).",
  withdrawing: "The candidate says they will not be joining or are withdrawing their acceptance.",
};

export const riskSignalSourceSchema = z.enum(["inbound_email", "pulse_response"]);
export type RiskSignalSource = z.infer<typeof riskSignalSourceSchema>;

export const riskSignalStatusSchema = z.enum(["open", "acknowledged"]);
export type RiskSignalStatus = z.infer<typeof riskSignalStatusSchema>;

// ─────────────────────────── pulse ───────────────────────────

export const pulseOnTrackSchema = z.enum(["yes", "unsure", "no"]);
export type PulseOnTrack = z.infer<typeof pulseOnTrackSchema>;
export const PULSE_COMMENT_MAX = 1000;

export const submitPulseResponseInputSchema = z.object({
  onTrack: pulseOnTrackSchema,
  /** Optional "how are you feeling about joining" 1..5. */
  feeling: z.number().int().min(1).max(5).nullable().optional(),
  comment: z.string().trim().max(PULSE_COMMENT_MAX).nullable().optional(),
});
export type SubmitPulseResponseInput = z.infer<typeof submitPulseResponseInputSchema>;

/**
 * A pulse answer → the signal it raises (or none). "Yes" raises nothing; the
 * candidate's optional comment, when present, is the quote — it is their own
 * words, verbatim, so it needs no verification.
 */
export function pulseAnswerSignal(
  onTrack: PulseOnTrack,
): Extract<RiskSignalType, "pulse_unsure" | "pulse_not_on_track"> | null {
  if (onTrack === "unsure") return "pulse_unsure";
  if (onTrack === "no") return "pulse_not_on_track";
  return null;
}

// ─────────────────────────── renege ───────────────────────────

export const RENEGE_REASON_CODES_DEFAULT = [
  "counter_offer",
  "another_offer",
  "relocation",
  "personal",
  "compensation",
  "other",
] as const;

const renegeReasonSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(80),
});
export type RenegeReason = z.infer<typeof renegeReasonSchema>;

export const PLATFORM_RENEGE_REASONS: RenegeReason[] = [
  { code: "counter_offer", label: "Accepted a counter-offer" },
  { code: "another_offer", label: "Accepted another offer" },
  { code: "relocation", label: "Relocation" },
  { code: "personal", label: "Personal reasons" },
  { code: "compensation", label: "Compensation" },
  { code: "other", label: "Other" },
];

export const RENEGE_NOTES_MAX = 2000;

// ─────────────────────────── settings ───────────────────────────

const stepToggleSchema = z.object({ key: preJoiningStepKeySchema, enabled: z.boolean() });

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const quietHoursSchema = z.object({
  enabled: z.boolean().default(true),
  /** Local hour (0–23) quiet time starts. */
  startHour: z.number().int().min(0).max(23).default(20),
  /** Local hour (0–23) quiet time ends — sends resume at this hour. */
  endHour: z.number().int().min(0).max(23).default(8),
  /**
   * IANA zone the hours (and the "which calendar day" of each touchpoint) are
   * read in. Platform default UTC; a tenant sets its own (e.g. Asia/Kolkata).
   */
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, "Unknown time zone")
    .default("UTC"),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const PRE_JOINING_CADENCE_MIN = 3;
export const PRE_JOINING_CADENCE_MAX = 60;
export const PRE_JOINING_CADENCE_DEFAULT = 14;

export const preJoiningEngagementSettingsSchema = z.object({
  /** Platform default OFF — a tenant opts in. */
  enabled: z.boolean().default(false),
  cadenceDays: z
    .number()
    .int()
    .min(PRE_JOINING_CADENCE_MIN)
    .max(PRE_JOINING_CADENCE_MAX)
    .default(PRE_JOINING_CADENCE_DEFAULT),
  steps: z
    .array(stepToggleSchema)
    .max(PRE_JOINING_STEP_KEYS.length)
    .refine((s) => new Set(s.map((x) => x.key)).size === s.length, "Duplicate step")
    .default(PRE_JOINING_STEP_KEYS.map((key) => ({ key, enabled: true }))),
  quietHours: quietHoursSchema.prefault({}),
  /** Display name on journey emails (the address stays the platform EMAIL_FROM). */
  senderName: z.string().trim().max(80).nullable().default(null),
  /** Free text shown in the "one week to go" email (reporting time, address, what to bring). */
  firstDayInfo: z.string().max(2000).default(""),
  signals: z
    .object({
      /** Signal types that are recorded at all. */
      enabled: z.array(riskSignalTypeSchema).default([...RISK_SIGNAL_TYPES]),
      /** Recorded signal types that also alert the recruiter (in-app + email). */
      alertOn: z.array(riskSignalTypeSchema).default([...RISK_SIGNAL_TYPES]),
    })
    .prefault({}),
  /** Renege reason lookup; platform default list when absent. */
  renegeReasons: z.array(renegeReasonSchema).min(1).max(30).default(PLATFORM_RENEGE_REASONS),
});
export type PreJoiningEngagementSettings = z.infer<typeof preJoiningEngagementSettingsSchema>;

export function defaultPreJoiningEngagementSettings(): PreJoiningEngagementSettings {
  return preJoiningEngagementSettingsSchema.parse({});
}

/**
 * Raw `settings.preJoiningEngagement` (absent / partial / corrupt) → a full,
 * valid block. Never throws: a malformed block resolves to the platform default
 * (which is disabled), the resolveRetentionPolicy discipline.
 */
export function resolvePreJoiningEngagementSettings(raw: unknown): PreJoiningEngagementSettings {
  const parsed = preJoiningEngagementSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultPreJoiningEngagementSettings();
}

export function isStepEnabled(s: PreJoiningEngagementSettings, key: PreJoiningStepKey): boolean {
  return s.steps.find((x) => x.key === key)?.enabled ?? false;
}

/** Should a signal of this type be recorded / alert, under the tenant settings? */
export function signalPolicy(
  s: PreJoiningEngagementSettings,
  type: RiskSignalType,
): { record: boolean; alert: boolean } {
  const record = s.signals.enabled.includes(type);
  return { record, alert: record && s.signals.alertOn.includes(type) };
}

// ─────────────────────────── time-zone helpers ───────────────────────────

const DAY_MS = 86_400_000;

/** Local calendar date + hour of an instant in `tz`. */
export function localParts(instant: Date, tz: string): { date: string; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/** Offset of `tz` from UTC at `instant`, in minutes (IST → +330). */
function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

/** The instant that is `hour`:00 local time on `date` in `tz`. */
export function zonedInstant(date: string, hour: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  let instant = guess - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  // One correction pass for a DST boundary between the guess and the answer.
  const again = guess - tzOffsetMinutes(new Date(instant), tz) * 60_000;
  if (again !== instant) instant = again;
  return new Date(instant);
}

/** 'YYYY-MM-DD' + n days. */
export function addDaysIso(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b ('YYYY-MM-DD'), b − a. */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);
}

export function isIsoDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function isQuietHour(hour: number, q: QuietHours): boolean {
  if (!q.enabled || q.startHour === q.endHour) return false;
  return q.startHour < q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}

/**
 * Move an instant out of the quiet window: inside it → the next local
 * `endHour`:00; outside → unchanged.
 */
export function applyQuietHours(instant: Date, q: QuietHours): Date {
  const { date, hour } = localParts(instant, q.timezone);
  if (!isQuietHour(hour, q)) return instant;
  const sameDay = zonedInstant(date, q.endHour, q.timezone);
  return sameDay.getTime() > instant.getTime()
    ? sameDay
    : zonedInstant(addDaysIso(date, 1), q.endHour, q.timezone);
}

/** The platform's default local send hour for scheduled touchpoints. */
export const PRE_JOINING_SEND_HOUR = 10;

/** Welcome is only sent if the journey starts within this long of the accept. */
export const WELCOME_WINDOW_DAYS = 3;

// ─────────────────────────── schedule generation ───────────────────────────

export interface PlannedTouchpoint {
  stepKey: PreJoiningStepKey;
  /** 1-based order within the step key (pulse 1, pulse 2, …). */
  sequence: number;
  scheduledFor: Date;
  carriesPulse: boolean;
}

/**
 * Plan the touchpoints from now until the joining date.
 *
 * Rules (all "days" are calendar days in the tenant's quiet-hours time zone):
 *   - nothing when the joining date is invalid or today/past;
 *   - welcome: now (out of quiet hours) when the accept is recent (≤3 days —
 *     a backfilled, long-accepted candidate does not get a "congratulations");
 *   - two/one weeks to go: joining −14 / −7 at the send hour, if still ahead;
 *   - pulses: every `cadenceDays` from the accept day, ahead of now, no later
 *     than joining −3, and not within 3 days of a countdown email;
 *   - company updates: half a cadence after each pulse slot, ahead of now, no
 *     later than joining −2, and not within 2 days of anything else;
 *   - short notice: when no check-in landed but there are ≥4 days to go, one
 *     pulse at the midpoint so every journey asks at least once.
 * Disabled steps are never planned. Output is sorted by time.
 */
export function planPreJoiningTouchpoints(args: {
  joiningDate: string;
  acceptedAt: Date;
  now: Date;
  settings: PreJoiningEngagementSettings;
}): PlannedTouchpoint[] {
  const { joiningDate, acceptedAt, now, settings } = args;
  if (!isIsoDateString(joiningDate)) return [];
  const q = settings.quietHours;
  const tz = q.timezone;
  const today = localParts(now, tz).date;
  const daysToJoin = daysBetweenIso(today, joiningDate);
  if (daysToJoin <= 0) return [];

  const sendHour = isQuietHour(PRE_JOINING_SEND_HOUR, q) ? q.endHour : PRE_JOINING_SEND_HOUR;
  const at = (date: string) => applyQuietHours(zonedInstant(date, sendHour, tz), q);
  const ahead = (d: Date) => d.getTime() > now.getTime();

  const out: { stepKey: PreJoiningStepKey; scheduledFor: Date; day: string }[] = [];
  const add = (stepKey: PreJoiningStepKey, scheduledFor: Date) =>
    out.push({ stepKey, scheduledFor, day: localParts(scheduledFor, tz).date });
  const near = (day: string, within: number, keys?: PreJoiningStepKey[]) =>
    out.some(
      (o) => (!keys || keys.includes(o.stepKey)) && Math.abs(daysBetweenIso(o.day, day)) < within,
    );

  if (isStepEnabled(settings, "welcome")) {
    const sinceAccept = (now.getTime() - acceptedAt.getTime()) / DAY_MS;
    if (sinceAccept <= WELCOME_WINDOW_DAYS) add("welcome", applyQuietHours(now, q));
  }

  for (const [key, offset] of [
    ["two_weeks_to_go", 14],
    ["one_week_to_go", 7],
  ] as const) {
    if (!isStepEnabled(settings, key)) continue;
    const day = addDaysIso(joiningDate, -offset);
    const when = at(day);
    if (ahead(when) && daysBetweenIso(day, joiningDate) > 0) add(key, when);
  }

  const acceptDay = localParts(acceptedAt, tz).date;
  const cadence = settings.cadenceDays;

  if (isStepEnabled(settings, "pulse")) {
    for (let k = 1; ; k++) {
      const day = addDaysIso(acceptDay, k * cadence);
      if (daysBetweenIso(day, joiningDate) < 3) break;
      const when = at(day);
      if (!ahead(when)) continue;
      if (near(day, 3, ["two_weeks_to_go", "one_week_to_go", "welcome"])) continue;
      add("pulse", when);
    }
  }

  if (isStepEnabled(settings, "company_update")) {
    const half = Math.floor(cadence / 2);
    for (let k = 0; ; k++) {
      const day = addDaysIso(acceptDay, k * cadence + half);
      if (daysBetweenIso(day, joiningDate) < 2) break;
      if (k === 0 && half === 0) continue;
      const when = at(day);
      if (!ahead(when)) continue;
      if (near(day, 2)) continue;
      add("company_update", when);
    }
  }

  const hasCheckIn = out.some((o) => PULSE_CARRYING_STEPS.has(o.stepKey));
  if (!hasCheckIn && isStepEnabled(settings, "pulse") && daysToJoin >= 4) {
    let day = addDaysIso(today, Math.floor(daysToJoin / 2));
    if (near(day, 1)) day = addDaysIso(day, -1);
    const when = at(day);
    if (ahead(when) && daysBetweenIso(day, joiningDate) > 0) add("pulse", when);
  }

  out.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  const counters = new Map<PreJoiningStepKey, number>();
  return out.map((o) => {
    const sequence = (counters.get(o.stepKey) ?? 0) + 1;
    counters.set(o.stepKey, sequence);
    return {
      stepKey: o.stepKey,
      sequence,
      scheduledFor: o.scheduledFor,
      carriesPulse: PULSE_CARRYING_STEPS.has(o.stepKey),
    };
  });
}

// ─────────────────────────── reply text + quote verification ───────────────────────────

/**
 * Drop the quoted history from an email reply so only what the candidate
 * wrote this time is classified (our own pulse question quoted back must not
 * read as the candidate's words). Cuts at the first "On … wrote:" line, an
 * "-----Original Message-----" / "From:" header block, or a run of ">" lines.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on .+wrote:$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^from:\s.+/i.test(t) && kept.length > 0) break;
    if (t.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Comparison form: lowercase, typographic punctuation folded, whitespace collapsed. */
export function normaliseQuoteText(input: string): string {
  return input
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

const WRAPPING = /^[\s"'‘’“”«»]+|[\s"'‘’“”«»]+$/g;
const EDGE_ELLIPSIS = /^(?:\.{3}|…)\s*|\s*(?:\.{3}|…)$/g;

/** Strip wrapping quote marks / edge ellipses a model adds around a quote. */
export function cleanSignalQuote(quote: string): string {
  let prev: string;
  let out = quote;
  do {
    prev = out;
    out = out.replace(WRAPPING, "").replace(EDGE_ELLIPSIS, "");
  } while (out !== prev);
  return out.trim();
}

/** Minimum quote length (after cleaning) — a 1–2 character "quote" proves nothing. */
export const SIGNAL_QUOTE_MIN_CHARS = 4;
export const SIGNAL_QUOTE_MAX_CHARS = 500;

/** Is `quote` a verbatim substring of `text` (under the normalisation above)? */
export function isVerbatimSignalQuote(quote: string, text: string): boolean {
  const q = normaliseQuoteText(cleanSignalQuote(quote));
  if (q.length < SIGNAL_QUOTE_MIN_CHARS) return false;
  return normaliseQuoteText(text).includes(q);
}

export interface RawClassifiedSignal {
  type: string;
  quote: string;
}

export interface VerifiedSignal {
  type: ClassifierSignalType;
  quote: string;
}

/**
 * The classifier's raw output → the signals we keep. Drops: unknown types,
 * quotes that are not verbatim in the (stripped) message, over-long quotes,
 * and duplicates of (type, quote). Keeps at most 3 per type. Returns the
 * kept signals and the count dropped (logged, never shown as a verdict).
 */
export function verifyClassifiedSignals(
  raw: readonly RawClassifiedSignal[],
  messageText: string,
): { signals: VerifiedSignal[]; dropped: number } {
  const signals: VerifiedSignal[] = [];
  const seen = new Set<string>();
  const perType = new Map<string, number>();
  let dropped = 0;
  for (const r of raw) {
    const type = classifierSignalTypeSchema.safeParse(r.type);
    const quote = cleanSignalQuote(typeof r.quote === "string" ? r.quote : "");
    if (
      !type.success ||
      quote.length > SIGNAL_QUOTE_MAX_CHARS ||
      !isVerbatimSignalQuote(quote, messageText)
    ) {
      dropped += 1;
      continue;
    }
    const key = `${type.data}␟${normaliseQuoteText(quote)}`;
    if (seen.has(key) || (perType.get(type.data) ?? 0) >= 3) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    perType.set(type.data, (perType.get(type.data) ?? 0) + 1);
    signals.push({ type: type.data, quote });
  }
  return { signals, dropped };
}

// ─────────────────────────── reply-to token ───────────────────────────

/** `replies+<token>@domain` — the token is 32 lowercase hex characters. */
export const REPLY_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function buildReplyToAddress(token: string, inboundDomain: string): string {
  return `replies+${token}@${inboundDomain}`;
}

/** Find the first reply token among recipient addresses ("Name <a@b>" tolerated). */
export function extractReplyToken(addresses: readonly string[]): string | null {
  for (const raw of addresses) {
    const m = /replies\+([a-f0-9]{32})@/i.exec(raw);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}

// ─────────────────────────── procedure contracts ───────────────────────────

export const getPreJoiningSettingsOutputSchema = preJoiningEngagementSettingsSchema;
export const updatePreJoiningSettingsInputSchema = preJoiningEngagementSettingsSchema;

export const companyUpdateInputSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  linkUrl: z.string().trim().url().max(1000).nullable().optional(),
  videoUrl: z.string().trim().url().max(1000).nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});
export type CompanyUpdateInput = z.infer<typeof companyUpdateInputSchema>;

export const companyUpdateRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  linkUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  sentCount: z.number().int(),
  updatedAt: z.string(),
});
export type CompanyUpdateRow = z.infer<typeof companyUpdateRowSchema>;

export const watchlistSignalChipSchema = z.object({
  id: z.string(),
  type: riskSignalTypeSchema,
  label: z.string(),
  quote: z.string().nullable(),
  createdAt: z.string(),
});

export const joiningWatchlistRowSchema = z.object({
  applicationId: z.string(),
  candidateId: z.string(),
  candidateName: z.string(),
  role: z.string(),
  businessUnit: z.string().nullable(),
  recruiterName: z.string().nullable(),
  joiningDate: z.string(),
  daysToJoining: z.number().int(),
  /** active | stopped | completed | none (no journey: engagement off or not started). */
  journeyStatus: z.string(),
  lastSentAt: z.string().nullable(),
  lastReceivedAt: z.string().nullable(),
  lastPulseAnswer: pulseOnTrackSchema.nullable(),
  lastPulseAt: z.string().nullable(),
  openSignals: z.array(watchlistSignalChipSchema),
  missedPulses: z.number().int(),
});
export type JoiningWatchlistRow = z.infer<typeof joiningWatchlistRowSchema>;

export const renegeHistoryRowSchema = z.object({
  applicationId: z.string(),
  candidateName: z.string(),
  role: z.string(),
  businessUnit: z.string().nullable(),
  joiningDate: z.string().nullable(),
  reasonCode: z.string(),
  reasonLabel: z.string(),
  notes: z.string().nullable(),
  recordedAt: z.string(),
});
export type RenegeHistoryRow = z.infer<typeof renegeHistoryRowSchema>;

export const listJoiningWatchlistInputSchema = z.object({}).default({});
export const listJoiningWatchlistOutputSchema = z.object({
  engagementEnabled: z.boolean(),
  rows: z.array(joiningWatchlistRowSchema),
  reneged: z.array(renegeHistoryRowSchema),
  renegeReasons: z.array(renegeReasonSchema),
});
export type ListJoiningWatchlistOutput = z.infer<typeof listJoiningWatchlistOutputSchema>;

export const engagementTimelineItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("touchpoint"),
    id: z.string(),
    at: z.string(),
    stepKey: preJoiningStepKeySchema,
    status: z.string(),
    carriesPulse: z.boolean(),
    detail: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("pulse_response"),
    id: z.string(),
    at: z.string(),
    onTrack: pulseOnTrackSchema,
    feeling: z.number().int().nullable(),
    comment: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("inbound_message"),
    id: z.string(),
    at: z.string(),
    fromEmail: z.string(),
    subject: z.string().nullable(),
    bodyText: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("signal"),
    id: z.string(),
    at: z.string(),
    type: riskSignalTypeSchema,
    label: z.string(),
    source: riskSignalSourceSchema,
    quote: z.string().nullable(),
    status: riskSignalStatusSchema,
  }),
  z.object({
    kind: z.literal("renege"),
    id: z.string(),
    at: z.string(),
    reasonLabel: z.string(),
    notes: z.string().nullable(),
  }),
]);
export type EngagementTimelineItem = z.infer<typeof engagementTimelineItemSchema>;

export const getEngagementTimelineInputSchema = z.object({ applicationId: z.string().uuid() });
export const getEngagementTimelineOutputSchema = z.object({
  applicationId: z.string(),
  candidateName: z.string(),
  role: z.string(),
  joiningDate: z.string().nullable(),
  currentStage: z.string(),
  journeyStatus: z.string(),
  journeyStopReason: z.string().nullable(),
  items: z.array(engagementTimelineItemSchema),
});
export type GetEngagementTimelineOutput = z.infer<typeof getEngagementTimelineOutputSchema>;

export const acknowledgeRiskSignalInputSchema = z.object({ signalId: z.string().uuid() });

export const recordRenegeInputSchema = z.object({
  applicationId: z.string().uuid(),
  reasonCode: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,40}$/),
  notes: z.string().trim().max(RENEGE_NOTES_MAX).nullable().optional(),
});
export type RecordRenegeInput = z.infer<typeof recordRenegeInputSchema>;

export const startPreJoiningJourneysOutputSchema = z.object({
  started: z.number().int(),
  skipped: z.number().int(),
});
