import { describe, expect, it } from "vitest";
import {
  applyQuietHours,
  buildReplyToAddress,
  defaultPreJoiningEngagementSettings,
  extractReplyToken,
  isVerbatimSignalQuote,
  localParts,
  planPreJoiningTouchpoints,
  pulseAnswerSignal,
  resolvePreJoiningEngagementSettings,
  signalPolicy,
  stripQuotedReply,
  verifyClassifiedSignals,
  zonedInstant,
  type PreJoiningEngagementSettings,
} from "../src/pre-joining-engagement";

/** Narrow away undefined/null, failing loudly (instead of a non-null assertion). */
function must<V>(v: V | null | undefined, what = "value"): V {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

/**
 * PC-14/15 — the pure half of pre-joining engagement: settings resolution,
 * schedule generation (incl. short notice periods + date edge cases), quiet
 * hours, quote verification and signal mapping.
 */

function settings(over: Partial<PreJoiningEngagementSettings> = {}): PreJoiningEngagementSettings {
  return { ...defaultPreJoiningEngagementSettings(), enabled: true, ...over };
}

const IST = { enabled: true, startHour: 20, endHour: 8, timezone: "Asia/Kolkata" };

describe("settings", () => {
  it("platform default is disabled, cadence 14, all steps on, all signals alert", () => {
    const d = defaultPreJoiningEngagementSettings();
    expect(d.enabled).toBe(false);
    expect(d.cadenceDays).toBe(14);
    expect(d.steps.map((s) => s.key)).toEqual([
      "welcome",
      "pulse",
      "company_update",
      "two_weeks_to_go",
      "one_week_to_go",
    ]);
    expect(d.steps.every((s) => s.enabled)).toBe(true);
    expect(d.signals.alertOn).toContain("other_offer");
    expect(d.renegeReasons.map((r) => r.code)).toEqual([
      "counter_offer",
      "another_offer",
      "relocation",
      "personal",
      "compensation",
      "other",
    ]);
  });

  it("partial block fills defaults; corrupt block falls back to default (disabled)", () => {
    const p = resolvePreJoiningEngagementSettings({ enabled: true, cadenceDays: 7 });
    expect(p.enabled).toBe(true);
    expect(p.cadenceDays).toBe(7);
    expect(p.quietHours.timezone).toBe("UTC");
    expect(resolvePreJoiningEngagementSettings({ cadenceDays: 1 }).enabled).toBe(false);
    expect(resolvePreJoiningEngagementSettings("nope").enabled).toBe(false);
    expect(
      resolvePreJoiningEngagementSettings({ quietHours: { timezone: "Mars/Olympus" } }).enabled,
    ).toBe(false);
  });

  it("signalPolicy: alert implies record; disabled type neither", () => {
    const s = settings({
      signals: {
        enabled: ["other_offer", "pulse_unsure"],
        alertOn: ["other_offer", "withdrawing"],
      },
    });
    expect(signalPolicy(s, "other_offer")).toEqual({ record: true, alert: true });
    expect(signalPolicy(s, "pulse_unsure")).toEqual({ record: true, alert: false });
    expect(signalPolicy(s, "withdrawing")).toEqual({ record: false, alert: false });
  });
});

describe("time zones + quiet hours", () => {
  it("zonedInstant gives the UTC instant of a local wall-clock hour", () => {
    expect(zonedInstant("2026-11-10", 10, "Asia/Kolkata").toISOString()).toBe(
      "2026-11-10T04:30:00.000Z",
    );
    expect(zonedInstant("2026-11-10", 10, "UTC").toISOString()).toBe("2026-11-10T10:00:00.000Z");
    // DST: New York is UTC-4 in July, UTC-5 in December.
    expect(zonedInstant("2026-07-01", 9, "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(zonedInstant("2026-12-01", 9, "America/New_York").toISOString()).toBe(
      "2026-12-01T14:00:00.000Z",
    );
  });

  it("applyQuietHours pushes a late-evening instant to next morning, leaves daytime alone", () => {
    // 22:00 IST = 16:30Z → next day 08:00 IST = 02:30Z
    expect(applyQuietHours(new Date("2026-11-10T16:30:00Z"), IST).toISOString()).toBe(
      "2026-11-11T02:30:00.000Z",
    );
    // 06:00 IST = 00:30Z → same day 08:00 IST
    expect(applyQuietHours(new Date("2026-11-10T00:30:00Z"), IST).toISOString()).toBe(
      "2026-11-10T02:30:00.000Z",
    );
    const noon = new Date("2026-11-10T06:30:00Z");
    expect(applyQuietHours(noon, IST).getTime()).toBe(noon.getTime());
    expect(
      applyQuietHours(new Date("2026-11-10T16:30:00Z"), { ...IST, enabled: false }).toISOString(),
    ).toBe("2026-11-10T16:30:00.000Z");
  });
});

describe("planPreJoiningTouchpoints", () => {
  const now = new Date("2026-11-10T06:00:00Z"); // 11:30 IST

  it("90-day notice: welcome now, pulses every 14 days, countdowns, company updates in between", () => {
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2027-02-08",
      acceptedAt: now,
      now,
      settings: settings({ quietHours: IST }),
    });
    const keys = plan.map((p) => p.stepKey);
    expect(keys[0]).toBe("welcome");
    expect(plan[0]?.scheduledFor.toISOString()).toBe(now.toISOString());
    expect(keys.filter((k) => k === "two_weeks_to_go")).toHaveLength(1);
    expect(keys.filter((k) => k === "one_week_to_go")).toHaveLength(1);
    expect(keys.filter((k) => k === "pulse").length).toBeGreaterThanOrEqual(4);
    expect(keys.filter((k) => k === "company_update").length).toBeGreaterThanOrEqual(3);
    // Sorted, all ahead of or at now, all before joining.
    for (let i = 1; i < plan.length; i++) {
      expect(must(plan[i]).scheduledFor.getTime()).toBeGreaterThanOrEqual(
        must(plan[i - 1]).scheduledFor.getTime(),
      );
    }
    const join = zonedInstant("2027-02-08", 0, "Asia/Kolkata").getTime();
    expect(plan.every((p) => p.scheduledFor.getTime() < join)).toBe(true);
    // Scheduled ones go out at 10:00 local.
    const twoWeeks = must(plan.find((p) => p.stepKey === "two_weeks_to_go"));
    expect(localParts(twoWeeks.scheduledFor, "Asia/Kolkata")).toEqual({
      date: "2027-01-25",
      hour: 10,
    });
    // Sequences are per step key.
    expect(plan.filter((p) => p.stepKey === "pulse").map((p) => p.sequence)).toEqual(
      plan.filter((p) => p.stepKey === "pulse").map((_, i) => i + 1),
    );
    // Only pulse + two-weeks carry the check-in.
    expect(
      plan
        .filter((p) => p.carriesPulse)
        .every((p) => ["pulse", "two_weeks_to_go"].includes(p.stepKey)),
    ).toBe(true);
  });

  it("no pulse lands within 3 days of a countdown email or in the last 3 days", () => {
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2027-02-08",
      acceptedAt: now,
      now,
      settings: settings({ quietHours: IST, cadenceDays: 7 }),
    });
    const day = (d: Date) => localParts(d, "Asia/Kolkata").date;
    const countdownDays = plan
      .filter((p) => p.stepKey === "two_weeks_to_go" || p.stepKey === "one_week_to_go")
      .map((p) => Date.parse(day(p.scheduledFor)));
    for (const p of plan.filter((x) => x.stepKey === "pulse")) {
      const t = Date.parse(day(p.scheduledFor));
      for (const c of countdownDays) expect(Math.abs(t - c)).toBeGreaterThanOrEqual(3 * 86_400_000);
      expect(Date.parse("2027-02-08") - t).toBeGreaterThanOrEqual(3 * 86_400_000);
    }
  });

  it("short notice (10 days): welcome + one-week-to-go + a midpoint pulse, no two-weeks", () => {
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2026-11-20",
      acceptedAt: now,
      now,
      settings: settings({ quietHours: IST }),
    });
    const keys = plan.map((p) => p.stepKey);
    expect(keys).toContain("welcome");
    expect(keys).toContain("one_week_to_go");
    expect(keys).not.toContain("two_weeks_to_go");
    expect(keys.filter((k) => k === "pulse")).toHaveLength(1);
  });

  it("very short notice (2 days): welcome only; joining today/past or invalid: nothing", () => {
    const base = { acceptedAt: now, now, settings: settings({ quietHours: IST }) };
    expect(
      planPreJoiningTouchpoints({ ...base, joiningDate: "2026-11-12" }).map((p) => p.stepKey),
    ).toEqual(["welcome"]);
    expect(planPreJoiningTouchpoints({ ...base, joiningDate: "2026-11-10" })).toEqual([]);
    expect(planPreJoiningTouchpoints({ ...base, joiningDate: "2026-11-01" })).toEqual([]);
    expect(planPreJoiningTouchpoints({ ...base, joiningDate: "2026-02-30" })).toEqual([]);
    expect(planPreJoiningTouchpoints({ ...base, joiningDate: "not-a-date" })).toEqual([]);
  });

  it("backfill: a long-accepted candidate gets no welcome and nothing in the past", () => {
    const acceptedAt = new Date("2026-09-01T06:00:00Z");
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2026-12-15",
      acceptedAt,
      now,
      settings: settings({ quietHours: IST }),
    });
    expect(plan.map((p) => p.stepKey)).not.toContain("welcome");
    expect(plan.every((p) => p.scheduledFor.getTime() > now.getTime())).toBe(true);
    expect(plan.some((p) => p.stepKey === "pulse")).toBe(true);
  });

  it("welcome accepted late in the evening is deferred to the morning", () => {
    const late = new Date("2026-11-10T17:00:00Z"); // 22:30 IST
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2027-01-10",
      acceptedAt: late,
      now: late,
      settings: settings({ quietHours: IST }),
    });
    expect(plan[0]?.stepKey).toBe("welcome");
    expect(localParts(must(plan[0]).scheduledFor, "Asia/Kolkata")).toEqual({
      date: "2026-11-11",
      hour: 8,
    });
  });

  it("disabled steps are never planned; all disabled → empty", () => {
    const s = settings({
      quietHours: IST,
      steps: [
        { key: "welcome", enabled: false },
        { key: "pulse", enabled: true },
        { key: "company_update", enabled: false },
        { key: "two_weeks_to_go", enabled: false },
        { key: "one_week_to_go", enabled: false },
      ],
    });
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2027-02-08",
      acceptedAt: now,
      now,
      settings: s,
    });
    expect(new Set(plan.map((p) => p.stepKey))).toEqual(new Set(["pulse"]));
    const none = planPreJoiningTouchpoints({
      joiningDate: "2027-02-08",
      acceptedAt: now,
      now,
      settings: settings({ steps: s.steps.map((x) => ({ ...x, enabled: false })) }),
    });
    expect(none).toEqual([]);
  });

  it("month-end / leap-year dates are handled as calendar days", () => {
    const n = new Date("2028-01-31T06:00:00Z");
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2028-03-01",
      acceptedAt: n,
      now: n,
      settings: settings(),
    });
    const tw = must(plan.find((p) => p.stepKey === "two_weeks_to_go"));
    expect(localParts(tw.scheduledFor, "UTC").date).toBe("2028-02-16");
    const ow = must(plan.find((p) => p.stepKey === "one_week_to_go"));
    expect(localParts(ow.scheduledFor, "UTC").date).toBe("2028-02-23");
  });
});

describe("quote verification + signal mapping", () => {
  const msg =
    "Hi Ashwin,\n\nThanks for checking in. Honestly my current company has made a counter offer and I’m thinking it over.\nAlso, my manager won't release me before 15 March.";

  it("keeps verbatim quotes (typographic quotes/whitespace folded), drops paraphrases and unknown types", () => {
    const r = verifyClassifiedSignals(
      [
        { type: "counter_offer", quote: "“my current company has made a counter offer”" },
        { type: "doubt_or_hesitation", quote: "I'm thinking it over" },
        { type: "notice_period_issue", quote: "my manager will not release me" },
        { type: "flight_risk_score", quote: "Thanks for checking in" },
        { type: "other_offer", quote: "" },
        { type: "counter_offer", quote: "my current company has made a counter offer" },
      ],
      msg,
    );
    expect(r.signals).toEqual([
      { type: "counter_offer", quote: "my current company has made a counter offer" },
      { type: "doubt_or_hesitation", quote: "I'm thinking it over" },
    ]);
    expect(r.dropped).toBe(4);
  });

  it("isVerbatimSignalQuote rejects too-short quotes", () => {
    expect(isVerbatimSignalQuote("Hi", msg)).toBe(false);
    expect(isVerbatimSignalQuote("won't release me", msg)).toBe(true);
  });

  it("stripQuotedReply removes the quoted history so our own words are not classified", () => {
    const reply =
      "Yes all good, see you then.\n\nOn Tue, 10 Nov 2026 at 10:00, Solenis <x@y.com> wrote:\n> Are you still on track to join? I have another offer?";
    expect(stripQuotedReply(reply)).toBe("Yes all good, see you then.");
    expect(stripQuotedReply("line one\n> quoted\nline two")).toBe("line one\nline two");
  });

  it("pulse answers map to signals: yes → none", () => {
    expect(pulseAnswerSignal("yes")).toBeNull();
    expect(pulseAnswerSignal("unsure")).toBe("pulse_unsure");
    expect(pulseAnswerSignal("no")).toBe("pulse_not_on_track");
  });

  it("reply-to token round-trips through an address list", () => {
    const tok = "0123456789abcdef0123456789abcdef";
    const addr = buildReplyToAddress(tok, "in.example.com");
    expect(addr).toBe(`replies+${tok}@in.example.com`);
    expect(extractReplyToken(["someone@else.com", `Solenis <${addr}>`])).toBe(tok);
    expect(extractReplyToken(["replies+short@in.example.com"])).toBeNull();
  });
});
