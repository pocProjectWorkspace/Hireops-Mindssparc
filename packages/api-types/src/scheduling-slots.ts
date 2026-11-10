/**
 * PC-8 — the interview slot engine. PURE: no DB, no clock reads (the caller
 * passes `now`), no third-party date library — only `Intl`, so the same code
 * runs in the api, the workers and a unit test.
 *
 * WHAT IT ANSWERS: "given these panellists' weekly availability, their blocked
 * ranges and the interviews already on their calendars, when could ALL of them
 * sit a round of N minutes?" — inside the tenant's working window, at least
 * `minNoticeHours` from now and at most `horizonDays` out, with `bufferMinutes`
 * of air either side of every existing interview.
 *
 * TIME MODEL. Every instant is an epoch-millisecond number and every output is
 * a UTC ISO string. Wall-clock facts (a panellist's "Mon 09:00–17:00", the
 * tenant's working hours) are expanded into concrete instants PER LOCAL DATE in
 * their own IANA zone, so a window keeps its wall-clock meaning across a DST
 * change (09:00 New York is 13:00Z in summer and 14:00Z in winter). Nothing
 * here assumes any particular zone — the platform default zone is UTC, and a
 * tenant sets its own.
 *
 * HONESTY. The engine never invents availability: a panellist with no weekly
 * windows is available NOWHERE unless the tenant has opted into
 * `assumeWorkingHoursWhenNoAvailability`, in which case they are treated as
 * free during the tenant's working window (and that choice is the tenant's,
 * visible on the scheduling settings page).
 */

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** One recurring weekly window, wall-clock in `timezone`. 0 = Sunday … 6 = Saturday. */
export interface WeeklyWindow {
  dayOfWeek: number;
  /** Minutes after local midnight, 0..1439. */
  startMinute: number;
  /** Minutes after local midnight, 1..1440 (1440 = end of day). Must be > startMinute. */
  endMinute: number;
  timezone: string;
}

export interface PanelistSchedule {
  membershipId: string;
  windows: WeeklyWindow[];
  /** Blocked / out-of-office ranges. */
  exceptions: Interval[];
  /** Interviews already on this panellist's calendar (raw — the engine adds the buffer). */
  busy: Interval[];
}

export interface SlotEngineConfig {
  /** The tenant's IANA zone — anchors working hours and the slot grid. */
  timezone: string;
  /** Tenant working window, minutes after local midnight. */
  workingHours: { startMinute: number; endMinute: number };
  /** Days the working window applies to (0 = Sunday … 6 = Saturday). */
  workingDays: number[];
  /** Treat a panellist with NO weekly windows as free during the working window. */
  assumeWorkingHoursWhenNoAvailability: boolean;
  bufferMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
  /** Slot start grid, aligned to the tenant's local wall clock. */
  slotIncrementMinutes: number;
}

export interface ComputeSlotsInput {
  panelists: PanelistSchedule[];
  durationMinutes: number;
  config: SlotEngineConfig;
  now: Date | number;
  /** Ranges blocked for everyone (e.g. the candidate's other interviews). Buffered like `busy`. */
  extraBusy?: Interval[];
}

export interface ProposedSlot {
  start: string;
  end: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ───────────────────────────── time-zone primitives ─────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** True when `tz` is an IANA zone this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  minuteOfDay: number;
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: number;
}

/** The wall-clock reading of `instant` in `tz`. */
export function localParts(tz: string, instant: number): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(instant));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number.parseInt(p.value, 10) : 0;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  return {
    year,
    month,
    day,
    minuteOfDay: hour * 60 + minute,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** `tz`'s offset from UTC at `instant`, in ms (IST → +19 800 000). */
export function tzOffsetMs(tz: string, instant: number): number {
  const truncated = instant - (((instant % 1000) + 1000) % 1000);
  const parts = formatterFor(tz).formatToParts(new Date(truncated));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number.parseInt(p.value, 10) : 0;
  };
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - truncated;
}

/**
 * The UTC instant for a wall-clock time in `tz`. `minuteOfDay` may be 1440
 * (end of day → next local midnight). Two-pass so it is correct on both sides
 * of a DST change; a wall time inside a spring-forward gap resolves to the
 * instant just after the gap rather than throwing.
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): number {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const off1 = tzOffsetMs(tz, guess);
  let utc = guess - off1;
  const off2 = tzOffsetMs(tz, utc);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

// ───────────────────────────── interval algebra ─────────────────────────────

/** Sort + merge overlapping/touching intervals, dropping empty ones. */
export function normalizeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const A = normalizeIntervals(a);
  const B = normalizeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const x = A[i];
    const y = B[j];
    if (!x || !y) break;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
    if (x.end < y.end) i += 1;
    else j += 1;
  }
  return out;
}

export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const B = normalizeIntervals(b);
  const out: Interval[] = [];
  for (const piece of normalizeIntervals(a)) {
    let cursor = piece.start;
    for (const cut of B) {
      if (cut.end <= cursor) continue;
      if (cut.start >= piece.end) break;
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start, piece.end) });
      cursor = Math.max(cursor, cut.end);
      if (cursor >= piece.end) break;
    }
    if (cursor < piece.end) out.push({ start: cursor, end: piece.end });
  }
  return out;
}

// ───────────────────────────── expansion ─────────────────────────────

/**
 * Expand weekly windows into concrete UTC intervals overlapping [from, to).
 * Iterates LOCAL calendar dates in each window's own zone (one day of slack on
 * each side) so a window is anchored to its wall clock on every date.
 */
export function expandWeeklyWindows(windows: WeeklyWindow[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  const byZone = new Map<string, WeeklyWindow[]>();
  for (const w of windows) {
    if (w.endMinute <= w.startMinute) continue;
    const list = byZone.get(w.timezone) ?? [];
    list.push(w);
    byZone.set(w.timezone, list);
  }
  for (const [tz, list] of byZone) {
    if (!isValidTimeZone(tz)) continue;
    const first = localParts(tz, from - DAY_MS);
    const last = localParts(tz, to + DAY_MS);
    const firstDay = Date.UTC(first.year, first.month - 1, first.day);
    const lastDay = Date.UTC(last.year, last.month - 1, last.day);
    for (let d = firstDay; d <= lastDay; d += DAY_MS) {
      const date = new Date(d);
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      const dow = date.getUTCDay();
      for (const w of list) {
        if (w.dayOfWeek !== dow) continue;
        const start = zonedTimeToUtc(tz, y, m, day, w.startMinute);
        const end = zonedTimeToUtc(tz, y, m, day, w.endMinute);
        if (end > start && end > from && start < to) out.push({ start, end });
      }
    }
  }
  return normalizeIntervals(out);
}

function workingWindows(config: SlotEngineConfig): WeeklyWindow[] {
  return config.workingDays.map((dayOfWeek) => ({
    dayOfWeek,
    startMinute: config.workingHours.startMinute,
    endMinute: config.workingHours.endMinute,
    timezone: config.timezone,
  }));
}

function buffered(list: Interval[], bufferMinutes: number): Interval[] {
  const pad = Math.max(0, bufferMinutes) * MINUTE_MS;
  return list.map((i) => ({ start: i.start - pad, end: i.end + pad }));
}

/** The search range: [now + minNotice, now + horizon). */
export function searchRange(config: SlotEngineConfig, now: Date | number): Interval {
  const nowMs = typeof now === "number" ? now : now.getTime();
  return {
    start: nowMs + Math.max(0, config.minNoticeHours) * HOUR_MS,
    end: nowMs + Math.max(1, config.horizonDays) * DAY_MS,
  };
}

/** One panellist's free time inside `range` (availability ∩ working window − exceptions − buffered busy). */
export function panelistFreeIntervals(
  p: PanelistSchedule,
  config: SlotEngineConfig,
  range: Interval,
): Interval[] {
  const work = expandWeeklyWindows(workingWindows(config), range.start, range.end);
  let base: Interval[];
  if (p.windows.length > 0) {
    base = intersectIntervals(expandWeeklyWindows(p.windows, range.start, range.end), work);
  } else if (config.assumeWorkingHoursWhenNoAvailability) {
    base = work;
  } else {
    base = [];
  }
  base = intersectIntervals(base, [range]);
  base = subtractIntervals(base, p.exceptions);
  return subtractIntervals(base, buffered(p.busy, config.bufferMinutes));
}

/** Time when EVERY panellist is free (empty for an empty panel — no panel, no slot). */
export function commonFreeIntervals(input: ComputeSlotsInput): Interval[] {
  if (input.panelists.length === 0) return [];
  const range = searchRange(input.config, input.now);
  let common: Interval[] = [range];
  for (const p of input.panelists) {
    common = intersectIntervals(common, panelistFreeIntervals(p, input.config, range));
    if (common.length === 0) return [];
  }
  return subtractIntervals(common, buffered(input.extraBusy ?? [], input.config.bufferMinutes));
}

/** Every slot start on the tenant's local grid that fits `durationMinutes` inside the free time. */
export function enumerateSlots(
  free: Interval[],
  durationMinutes: number,
  config: SlotEngineConfig,
): Interval[] {
  const inc = Math.max(5, config.slotIncrementMinutes) * MINUTE_MS;
  const dur = Math.max(1, durationMinutes) * MINUTE_MS;
  const out: Interval[] = [];
  for (const piece of normalizeIntervals(free)) {
    // Align to the local wall clock: an IST tenant with a 30-minute grid gets
    // 09:00/09:30 local, not :00/:30 UTC (which would be :30/:00 local).
    const off = tzOffsetMs(config.timezone, piece.start);
    const local = piece.start + off;
    let t = Math.ceil(local / inc) * inc - off;
    while (t + dur <= piece.end) {
      out.push({ start: t, end: t + dur });
      t += inc;
    }
  }
  return out;
}

/**
 * Rank: spread the offer across days (the earliest slot of each day first,
 * then each day's second, …) so "5 slots" is not five consecutive half-hours
 * on one morning, then return chronologically.
 */
export function rankSlots(slots: Interval[], timezone: string, limit: number): Interval[] {
  if (limit <= 0) return [];
  const byDay = new Map<string, Interval[]>();
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    const lp = localParts(timezone, s.start);
    const key = `${lp.year}-${lp.month}-${lp.day}`;
    const list = byDay.get(key) ?? [];
    list.push(s);
    byDay.set(key, list);
  }
  const days = [...byDay.values()];
  const picked: Interval[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let any = false;
    for (const day of days) {
      const s = day[round];
      if (s) {
        any = true;
        picked.push(s);
        if (picked.length >= limit) break;
      }
    }
    if (!any) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}

export interface ComputeSlotsResult {
  slots: ProposedSlot[];
  /** How many grid slots were free in total (before the limit). */
  totalFree: number;
}

/** Free intervals → grid slots → ranked top `limit`, as UTC ISO strings. */
export function computeCommonSlots(input: ComputeSlotsInput, limit: number): ComputeSlotsResult {
  const free = commonFreeIntervals(input);
  const all = enumerateSlots(free, input.durationMinutes, input.config);
  const ranked = rankSlots(all, input.config.timezone, limit);
  return {
    slots: ranked.map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
    })),
    totalFree: all.length,
  };
}

/** Is [start, start + duration) entirely inside the common free time right now? */
export function isSlotFree(input: ComputeSlotsInput, start: number): boolean {
  const end = start + Math.max(1, input.durationMinutes) * MINUTE_MS;
  return commonFreeIntervals(input).some((i) => i.start <= start && end <= i.end);
}

// ───────────────────────────── HH:MM helpers ─────────────────────────────

/** "09:30" → 570; "24:00" → 1440. Returns NaN for anything else. */
export function hhmmToMinutes(v: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return 1440;
  if (h > 23 || min > 59) return Number.NaN;
  return h * 60 + min;
}

/** 570 → "09:30"; 1440 → "24:00". */
export function minutesToHhmm(v: number): string {
  const h = Math.floor(v / 60);
  const m = v % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
