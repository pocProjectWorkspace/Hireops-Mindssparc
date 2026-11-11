import { describe, expect, it } from "vitest";
import {
  commonFreeIntervals,
  computeCommonSlots,
  expandWeeklyWindows,
  hhmmToMinutes,
  isSlotFree,
  isValidTimeZone,
  localParts,
  minutesToHhmm,
  rankSlots,
  subtractIntervals,
  intersectIntervals,
  zonedTimeToUtc,
  type PanelistSchedule,
  type SlotEngineConfig,
  type WeeklyWindow,
} from "../src/scheduling-slots";
import {
  PLATFORM_DEFAULT_TIMEZONE,
  defaultSchedulingSettings,
  resolveSchedulingSettings,
  schedulingSettingsSchema,
  slotEngineConfigFrom,
} from "../src/scheduling";

/**
 * PC-8 — the slot engine. Pure: every test passes its own `now`.
 *
 * Pinned:
 *   - recurring weekly windows expand on the right LOCAL dates in their zone;
 *   - time zones: an IST window and a New York window intersect correctly;
 *   - DST: a 09:00 New York window is 13:00Z in summer and 14:00Z in winter,
 *     and the 09:00 window on the DST-change day is still 09:00 local
 *     (Europe/Berlin too — the engine is not IST-shaped);
 *   - exceptions remove time; existing interviews remove time PLUS buffer;
 *   - min notice + horizon bound the search;
 *   - the slot grid is aligned to the tenant's local clock;
 *   - an empty panel or a panellist with no availability yields no slots
 *     (unless the tenant opts into assumeWorkingHoursWhenNoAvailability);
 *   - settings resolve platform-default → tenant settings.timezone → block.
 */

function cfg(over: Partial<SlotEngineConfig> = {}): SlotEngineConfig {
  return {
    timezone: "UTC",
    workingHours: { startMinute: 0, endMinute: 1440 },
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    assumeWorkingHoursWhenNoAvailability: false,
    bufferMinutes: 0,
    minNoticeHours: 0,
    horizonDays: 14,
    slotIncrementMinutes: 30,
    ...over,
  };
}

function weekdays(start: string, end: string, timezone: string): WeeklyWindow[] {
  return [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startMinute: hhmmToMinutes(start),
    endMinute: hhmmToMinutes(end),
    timezone,
  }));
}

function panelist(id: string, windows: WeeklyWindow[], extra: Partial<PanelistSchedule> = {}) {
  return { membershipId: id, windows, exceptions: [], busy: [], ...extra };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("time-zone primitives", () => {
  it("validates IANA names", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("zonedTimeToUtc handles a fixed-offset zone", () => {
    // 09:00 IST (UTC+5:30) = 03:30Z
    expect(iso(zonedTimeToUtc("Asia/Kolkata", 2026, 11, 16, 9 * 60))).toBe(
      "2026-11-16T03:30:00.000Z",
    );
  });

  it("zonedTimeToUtc is DST-correct for America/New_York", () => {
    // Summer (EDT, UTC-4): 09:00 → 13:00Z. Winter (EST, UTC-5): 09:00 → 14:00Z.
    expect(iso(zonedTimeToUtc("America/New_York", 2026, 7, 6, 540))).toBe(
      "2026-07-06T13:00:00.000Z",
    );
    expect(iso(zonedTimeToUtc("America/New_York", 2026, 12, 7, 540))).toBe(
      "2026-12-07T14:00:00.000Z",
    );
    // DST ends Sun 1 Nov 2026; Mon 2 Nov is already EST.
    expect(iso(zonedTimeToUtc("America/New_York", 2026, 11, 2, 540))).toBe(
      "2026-11-02T14:00:00.000Z",
    );
    // Friday 30 Oct is still EDT.
    expect(iso(zonedTimeToUtc("America/New_York", 2026, 10, 30, 540))).toBe(
      "2026-10-30T13:00:00.000Z",
    );
  });

  it("zonedTimeToUtc resolves a spring-forward gap time instead of throwing", () => {
    // Europe/Berlin springs forward 29 Mar 2026 02:00 → 03:00. 02:30 does not exist.
    const t = zonedTimeToUtc("Europe/Berlin", 2026, 3, 29, 150);
    expect(Number.isFinite(t)).toBe(true);
    const lp = localParts("Europe/Berlin", t);
    expect(lp.day).toBe(29);
  });

  it("localParts gives the local weekday", () => {
    // 2026-11-16T20:00Z is Tuesday 01:30 in Kolkata, Monday 15:00 in New York.
    const t = Date.UTC(2026, 10, 16, 20, 0);
    expect(localParts("Asia/Kolkata", t).dayOfWeek).toBe(2);
    expect(localParts("America/New_York", t).dayOfWeek).toBe(1);
  });

  it("HH:MM helpers round-trip", () => {
    expect(hhmmToMinutes("09:30")).toBe(570);
    expect(hhmmToMinutes("24:00")).toBe(1440);
    expect(Number.isNaN(hhmmToMinutes("25:00"))).toBe(true);
    expect(minutesToHhmm(570)).toBe("09:30");
    expect(minutesToHhmm(1440)).toBe("24:00");
  });
});

describe("interval algebra", () => {
  it("intersects and subtracts", () => {
    expect(intersectIntervals([{ start: 0, end: 10 }], [{ start: 5, end: 15 }])).toEqual([
      { start: 5, end: 10 },
    ]);
    expect(
      subtractIntervals(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 5, end: 7 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 7, end: 10 },
    ]);
  });
});

describe("recurring weekly windows", () => {
  it("expand only on their weekday, in their own zone", () => {
    // Monday 16 Nov 2026 … Sunday 22 Nov 2026.
    const from = Date.UTC(2026, 10, 16);
    const to = Date.UTC(2026, 10, 23);
    const out = expandWeeklyWindows(
      [{ dayOfWeek: 3, startMinute: 600, endMinute: 660, timezone: "Asia/Kolkata" }],
      from,
      to,
    );
    expect(out.map((i) => [iso(i.start), iso(i.end)])).toEqual([
      ["2026-11-18T04:30:00.000Z", "2026-11-18T05:30:00.000Z"], // Wed 10:00–11:00 IST
    ]);
  });

  it("a 09:00 New York window crosses the DST change and stays at 09:00 local", () => {
    const from = Date.UTC(2026, 9, 26); // Mon 26 Oct
    const to = Date.UTC(2026, 10, 7); // Sat 7 Nov
    const out = expandWeeklyWindows(
      [{ dayOfWeek: 1, startMinute: 540, endMinute: 600, timezone: "America/New_York" }],
      from,
      to,
    );
    expect(out.map((i) => iso(i.start))).toEqual([
      "2026-10-26T13:00:00.000Z", // EDT
      "2026-11-02T14:00:00.000Z", // EST
    ]);
  });
});

describe("computeCommonSlots", () => {
  const MONDAY = Date.UTC(2026, 10, 16, 0, 0); // Mon 16 Nov 2026 00:00Z

  it("intersects two panellists in different zones", () => {
    // A: 09:00–17:00 IST (03:30–11:30Z). B: 05:00–08:00 New York in winter (10:00–13:00Z).
    // Common: 10:00–11:30Z → 30-min grid on UTC → 10:00, 10:30, 11:00 starts for 30 min.
    const result = computeCommonSlots(
      {
        panelists: [
          panelist("a", weekdays("09:00", "17:00", "Asia/Kolkata")),
          panelist("b", weekdays("05:00", "08:00", "America/New_York")),
        ],
        durationMinutes: 30,
        config: cfg({ horizonDays: 1 }),
        now: MONDAY,
      },
      10,
    );
    expect(result.slots.map((s) => s.start)).toEqual([
      "2026-11-16T10:00:00.000Z",
      "2026-11-16T10:30:00.000Z",
      "2026-11-16T11:00:00.000Z",
    ]);
  });

  it("aligns the grid to the tenant's local clock (IST half-hour offset)", () => {
    const result = computeCommonSlots(
      {
        panelists: [panelist("a", weekdays("10:00", "11:00", "Asia/Kolkata"))],
        durationMinutes: 30,
        config: cfg({ timezone: "Asia/Kolkata", horizonDays: 1 }),
        now: MONDAY,
      },
      10,
    );
    // 10:00 and 10:30 IST, i.e. 04:30Z and 05:00Z.
    expect(result.slots.map((s) => s.start)).toEqual([
      "2026-11-16T04:30:00.000Z",
      "2026-11-16T05:00:00.000Z",
    ]);
  });

  it("removes exceptions (OOO) from availability", () => {
    const result = computeCommonSlots(
      {
        panelists: [
          panelist("a", weekdays("09:00", "12:00", "UTC"), {
            exceptions: [{ start: Date.UTC(2026, 10, 16, 9, 30), end: Date.UTC(2026, 10, 16, 11) }],
          }),
        ],
        durationMinutes: 30,
        config: cfg({ horizonDays: 1 }),
        now: MONDAY,
      },
      10,
    );
    expect(result.slots.map((s) => s.start)).toEqual([
      "2026-11-16T09:00:00.000Z",
      "2026-11-16T11:00:00.000Z",
      "2026-11-16T11:30:00.000Z",
    ]);
  });

  it("removes existing interviews plus the buffer on both sides", () => {
    const result = computeCommonSlots(
      {
        panelists: [
          panelist("a", weekdays("09:00", "13:00", "UTC"), {
            busy: [{ start: Date.UTC(2026, 10, 16, 10), end: Date.UTC(2026, 10, 16, 11) }],
          }),
        ],
        durationMinutes: 45,
        config: cfg({ horizonDays: 1, bufferMinutes: 15, slotIncrementMinutes: 15 }),
        now: MONDAY,
      },
      20,
    );
    // Busy 10:00–11:00 + 15 min buffer → blocked 09:45–11:15.
    // 45-min slots: 09:00 (ends 09:45 ✓), then 11:15, 11:30, 11:45, 12:00, 12:15 (ends 13:00).
    expect(result.slots.map((s) => s.start.slice(11, 16))).toEqual([
      "09:00",
      "11:15",
      "11:30",
      "11:45",
      "12:00",
      "12:15",
    ]);
  });

  it("extraBusy (the candidate's other rounds) blocks everyone", () => {
    const free = commonFreeIntervals({
      panelists: [panelist("a", weekdays("09:00", "12:00", "UTC"))],
      durationMinutes: 30,
      config: cfg({ horizonDays: 1 }),
      now: MONDAY,
      extraBusy: [{ start: Date.UTC(2026, 10, 16, 10), end: Date.UTC(2026, 10, 16, 11) }],
    });
    expect(free.map((i) => [iso(i.start).slice(11, 16), iso(i.end).slice(11, 16)])).toEqual([
      ["09:00", "10:00"],
      ["11:00", "12:00"],
    ]);
  });

  it("honours min notice and the horizon", () => {
    const now = Date.UTC(2026, 10, 16, 8, 0); // Mon 08:00Z
    const result = computeCommonSlots(
      {
        panelists: [panelist("a", weekdays("09:00", "17:00", "UTC"))],
        durationMinutes: 60,
        config: cfg({ minNoticeHours: 24, horizonDays: 2, slotIncrementMinutes: 60 }),
        now,
      },
      50,
    );
    // Search [Tue 08:00Z, Wed 08:00Z) → only Tuesday 09:00–17:00 (8 hourly slots).
    expect(result.slots.length).toBe(8);
    expect(result.slots[0]!.start).toBe("2026-11-17T09:00:00.000Z");
    expect(result.slots.at(-1)!.start).toBe("2026-11-17T16:00:00.000Z");
  });

  it("restricts to tenant working hours and working days", () => {
    const result = computeCommonSlots(
      {
        // Panellist claims 24/7 availability.
        panelists: [
          panelist(
            "a",
            [0, 1, 2, 3, 4, 5, 6].map((d) => ({
              dayOfWeek: d,
              startMinute: 0,
              endMinute: 1440,
              timezone: "UTC",
            })),
          ),
        ],
        durationMinutes: 60,
        config: cfg({
          workingHours: { startMinute: 600, endMinute: 720 },
          workingDays: [1],
          horizonDays: 7,
          slotIncrementMinutes: 60,
        }),
        now: MONDAY,
      },
      50,
    );
    expect(result.slots.map((s) => s.start)).toEqual([
      "2026-11-16T10:00:00.000Z",
      "2026-11-16T11:00:00.000Z",
    ]);
  });

  it("a panellist with NO availability yields no slots unless the tenant opts in", () => {
    const base = {
      panelists: [panelist("a", weekdays("09:00", "17:00", "UTC")), panelist("b", [])],
      durationMinutes: 60,
      now: MONDAY,
    };
    expect(computeCommonSlots({ ...base, config: cfg({ horizonDays: 1 }) }, 5).slots).toEqual([]);
    const optIn = computeCommonSlots(
      {
        ...base,
        config: cfg({
          horizonDays: 1,
          assumeWorkingHoursWhenNoAvailability: true,
          workingHours: { startMinute: 600, endMinute: 720 },
          slotIncrementMinutes: 60,
        }),
      },
      5,
    );
    expect(optIn.slots.map((s) => s.start)).toEqual([
      "2026-11-16T10:00:00.000Z",
      "2026-11-16T11:00:00.000Z",
    ]);
  });

  it("an empty panel yields no slots", () => {
    expect(
      computeCommonSlots({ panelists: [], durationMinutes: 30, config: cfg(), now: MONDAY }, 5)
        .slots,
    ).toEqual([]);
  });

  it("DST-safe for a non-IST tenant: Berlin 09:00 slots across the October change", () => {
    // Europe/Berlin falls back Sun 25 Oct 2026 (CEST UTC+2 → CET UTC+1).
    const now = Date.UTC(2026, 9, 22, 0, 0); // Thu 22 Oct
    const result = computeCommonSlots(
      {
        panelists: [panelist("a", weekdays("09:00", "10:00", "Europe/Berlin"))],
        durationMinutes: 60,
        config: cfg({ timezone: "Europe/Berlin", horizonDays: 6, slotIncrementMinutes: 60 }),
        now,
      },
      10,
    );
    expect(result.slots.map((s) => s.start)).toEqual([
      "2026-10-22T07:00:00.000Z", // Thu 09:00 CEST
      "2026-10-23T07:00:00.000Z", // Fri 09:00 CEST
      "2026-10-26T08:00:00.000Z", // Mon 09:00 CET
      "2026-10-27T08:00:00.000Z", // Tue 09:00 CET
    ]);
  });

  it("ranks across days rather than packing one morning", () => {
    const slots = [
      { start: Date.UTC(2026, 10, 16, 9), end: Date.UTC(2026, 10, 16, 9, 30) },
      { start: Date.UTC(2026, 10, 16, 9, 30), end: Date.UTC(2026, 10, 16, 10) },
      { start: Date.UTC(2026, 10, 16, 10), end: Date.UTC(2026, 10, 16, 10, 30) },
      { start: Date.UTC(2026, 10, 17, 9), end: Date.UTC(2026, 10, 17, 9, 30) },
      { start: Date.UTC(2026, 10, 18, 9), end: Date.UTC(2026, 10, 18, 9, 30) },
    ];
    const picked = rankSlots(slots, "UTC", 3).map((s) => iso(s.start));
    expect(picked).toEqual([
      "2026-11-16T09:00:00.000Z",
      "2026-11-17T09:00:00.000Z",
      "2026-11-18T09:00:00.000Z",
    ]);
  });

  it("isSlotFree re-checks one start against current state", () => {
    const input = {
      panelists: [
        panelist("a", weekdays("09:00", "12:00", "UTC"), {
          busy: [{ start: Date.UTC(2026, 10, 16, 10), end: Date.UTC(2026, 10, 16, 10, 30) }],
        }),
      ],
      durationMinutes: 30,
      config: cfg({ horizonDays: 1 }),
      now: MONDAY,
    };
    expect(isSlotFree(input, Date.UTC(2026, 10, 16, 9))).toBe(true);
    expect(isSlotFree(input, Date.UTC(2026, 10, 16, 10))).toBe(false);
    expect(isSlotFree(input, Date.UTC(2026, 10, 16, 9, 45))).toBe(false);
  });
});

describe("scheduling settings resolver", () => {
  it("defaults are platform-generic: UTC, 30/45/60 with 45 default", () => {
    const d = defaultSchedulingSettings();
    expect(d.durationPresets).toEqual([30, 45, 60]);
    expect(d.defaultDurationMinutes).toBe(45);
    expect(d.maxCandidateReschedules).toBe(2);
    const r = resolveSchedulingSettings({});
    expect(r.timezone).toBe(PLATFORM_DEFAULT_TIMEZONE);
    expect(r.timezone).toBe("UTC");
    expect(r.timezoneSource).toBe("platform");
  });

  it("uses the tenant's settings.timezone when the block has none", () => {
    const r = resolveSchedulingSettings({ timezone: "Europe/Berlin" });
    expect(r.timezone).toBe("Europe/Berlin");
    expect(r.timezoneSource).toBe("tenant");
  });

  it("the block's own timezone wins", () => {
    const r = resolveSchedulingSettings({
      timezone: "Europe/Berlin",
      scheduling: { timezone: "Asia/Kolkata" },
    });
    expect(r.timezone).toBe("Asia/Kolkata");
    expect(r.timezoneSource).toBe("scheduling");
  });

  it("a malformed block falls back to defaults wholesale", () => {
    const r = resolveSchedulingSettings({ scheduling: { bufferMinutes: -5 } });
    expect(r.bufferMinutes).toBe(defaultSchedulingSettings().bufferMinutes);
  });

  it("rejects an end-before-start working window and a default outside the presets", () => {
    expect(
      schedulingSettingsSchema.safeParse({ workingHoursStart: "18:00", workingHoursEnd: "09:00" })
        .success,
    ).toBe(false);
    expect(
      schedulingSettingsSchema.safeParse({ durationPresets: [30, 60], defaultDurationMinutes: 45 })
        .success,
    ).toBe(false);
    expect(schedulingSettingsSchema.safeParse({ timezone: "Not/AZone" }).success).toBe(false);
  });

  it("maps to an engine config", () => {
    const c = slotEngineConfigFrom(resolveSchedulingSettings({}));
    expect(c.workingHours).toEqual({ startMinute: 540, endMinute: 1080 });
    expect(c.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(c.horizonDays).toBe(14);
  });
});
