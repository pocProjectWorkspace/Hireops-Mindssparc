import { describe, expect, it } from "vitest";
import {
  REPORT_DIGESTS_VERSION,
  defaultReportDigests,
  resolveReportDigests,
  digestPeriod,
  shouldSendDigest,
  reportDigestDedupKey,
} from "../src/admin-ops";

/**
 * R1.5a — scheduled report digests.
 *
 * These are the PURE decision functions the digest worker delegates to, and
 * they carry the whole design:
 *   - resolveReportDigests gives the resolve-over-defaults discipline (never
 *     throws; an unconfigured tenant is byte-identical to digests-off), which
 *     is what lets a cross-tenant scan survive one tenant's malformed JSON.
 *   - digestPeriod decides WHICH window is reported, and its periodKey is half
 *     of the dedup key that IS this feature's idempotency mechanism (there is
 *     no digest table — see the block header in admin-ops.ts). Get the period
 *     wrong and the key is wrong, and a digest either double-sends or silently
 *     never does.
 *   - shouldSendDigest decides WHEN, and is deliberately monotone within the
 *     period so a missed tick self-heals.
 *
 * Kept pure (no DB) so the load-bearing core is covered without live-DB flake;
 * the worker's remaining logic is a boolean guard over these same helpers plus
 * the report call.
 *
 * Every date below is UTC on purpose. Reference points used throughout:
 * Mon 10 Aug 2026 → Sun 16 Aug 2026 is ISO week 2026-W33; Mon 17 Aug 2026
 * starts 2026-W34.
 */

describe("resolveReportDigests", () => {
  it("empty block resolves to the disabled defaults (unconfigured = no digests)", () => {
    expect(resolveReportDigests({})).toEqual({
      version: REPORT_DIGESTS_VERSION,
      enabled: false,
      cadence: "weekly",
      recipients: [],
      sendHourUtc: 7,
    });
    expect(resolveReportDigests(undefined)).toEqual(defaultReportDigests());
    expect(resolveReportDigests(null)).toEqual(defaultReportDigests());
  });

  it("merges a partial block over defaults", () => {
    const r = resolveReportDigests({ enabled: true, cadence: "monthly" });
    expect(r.enabled).toBe(true);
    expect(r.cadence).toBe("monthly");
    // Untouched fields keep their code defaults.
    expect(r.sendHourUtc).toBe(7);
    expect(r.recipients).toEqual([]);
    expect(r.version).toBe(REPORT_DIGESTS_VERSION);
  });

  it("lower-cases, dedups and sorts recipients so the list is deterministic", () => {
    expect(
      resolveReportDigests({
        recipients: ["Zoe@example.com", "amit@example.com", "ZOE@example.com"],
      }).recipients,
    ).toEqual(["amit@example.com", "zoe@example.com"]);
  });

  it("malformed values fall back to defaults rather than throwing", () => {
    // A single invalid address invalidates the block → safe defaults (off).
    expect(resolveReportDigests({ enabled: true, recipients: ["not-an-email"] })).toEqual(
      defaultReportDigests(),
    );
    expect(resolveReportDigests({ cadence: "daily" })).toEqual(defaultReportDigests());
    expect(resolveReportDigests({ sendHourUtc: 24 })).toEqual(defaultReportDigests());
    expect(resolveReportDigests({ sendHourUtc: 6.5 })).toEqual(defaultReportDigests());
    expect(resolveReportDigests("garbage")).toEqual(defaultReportDigests());
    // Over the 10-recipient cap.
    expect(
      resolveReportDigests({
        recipients: Array.from({ length: 11 }, (_, i) => `ops${i}@example.com`),
      }),
    ).toEqual(defaultReportDigests());
  });
});

describe("digestPeriod — weekly", () => {
  it("returns the ISO week that just ended, Monday 00:00Z to Sunday 23:59:59.999Z", () => {
    // Tuesday 18 Aug 2026 sits in W34, so the closed week is W33.
    const p = digestPeriod("weekly", new Date("2026-08-18T09:00:00.000Z"));
    expect(p.periodKey).toBe("2026-W33");
    expect(p.from.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-08-16T23:59:59.999Z");
  });

  it("never reports the week in progress, even on its last day", () => {
    // Sunday 16 Aug is the FINAL day of W33 — W33 has not closed yet, so the
    // digest still covers W32. (A digest that reported a half-finished week
    // would be wrong on arrival.)
    const p = digestPeriod("weekly", new Date("2026-08-16T23:00:00.000Z"));
    expect(p.periodKey).toBe("2026-W32");
    expect(p.from.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-08-09T23:59:59.999Z");
  });

  it("handles an ISO week that spans Dec/Jan — the week belongs to the year owning its Thursday", () => {
    // Mon 4 Jan 2027 opens 2027-W01. The closed week is Mon 28 Dec 2026 →
    // Sun 3 Jan 2027: it straddles the new year, and because its Thursday
    // (31 Dec 2026) is in 2026 it is 2026-W53, not 2027-W01.
    const p = digestPeriod("weekly", new Date("2027-01-04T08:00:00.000Z"));
    expect(p.periodKey).toBe("2026-W53");
    expect(p.from.toISOString()).toBe("2026-12-28T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2027-01-03T23:59:59.999Z");
  });

  it("handles a year boundary where the closed week sits wholly in the previous year", () => {
    // Thu 1 Jan 2026 is in 2026-W01; the closed week is 2025-W52.
    const p = digestPeriod("weekly", new Date("2026-01-01T08:00:00.000Z"));
    expect(p.periodKey).toBe("2025-W52");
    expect(p.from.toISOString()).toBe("2025-12-22T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2025-12-28T23:59:59.999Z");
  });
});

describe("digestPeriod — monthly", () => {
  it("returns the previous calendar month, first to last instant", () => {
    const p = digestPeriod("monthly", new Date("2026-08-03T07:00:00.000Z"));
    expect(p.periodKey).toBe("2026-07");
    expect(p.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("crosses the year boundary in January", () => {
    const p = digestPeriod("monthly", new Date("2026-01-05T07:00:00.000Z"));
    expect(p.periodKey).toBe("2025-12");
    expect(p.from.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2025-12-31T23:59:59.999Z");
  });

  it("gets a short month's last instant right (Feb, non-leap)", () => {
    const p = digestPeriod("monthly", new Date("2026-03-01T07:00:00.000Z"));
    expect(p.periodKey).toBe("2026-02");
    expect(p.to.toISOString()).toBe("2026-02-28T23:59:59.999Z");
  });
});

describe("shouldSendDigest", () => {
  it("weekly: false before the send hour on the first day of the new week, true from it", () => {
    // Mon 17 Aug 2026 opens 2026-W34; the digest for W33 unlocks at 07:00Z.
    expect(shouldSendDigest("weekly", new Date("2026-08-17T06:59:59.999Z"), 7)).toBe(false);
    expect(shouldSendDigest("weekly", new Date("2026-08-17T07:00:00.000Z"), 7)).toBe(true);
  });

  it("weekly: stays true later in the week — a missed tick self-heals", () => {
    // Worker down all Monday: Wednesday's tick still sends W33's digest, and
    // the dedup key (not this gate) is what stops a second one.
    expect(shouldSendDigest("weekly", new Date("2026-08-19T03:00:00.000Z"), 7)).toBe(true);
  });

  it("weekly: hour 0 unlocks at the very first instant of the new week", () => {
    // The gate is always relative to the period `now` is IN: at 00:00Z on Mon
    // 17 Aug the closed period is W33 and hour 0 unlocks it immediately. A
    // millisecond earlier we are still inside W33, the closed period is W32 —
    // whose hour-0 gate opened a week before — so it is true there too, which
    // is the monotone property, not a bug.
    expect(shouldSendDigest("weekly", new Date("2026-08-17T00:00:00.000Z"), 0)).toBe(true);
    expect(shouldSendDigest("weekly", new Date("2026-08-16T23:59:59.999Z"), 0)).toBe(true);
  });

  it("weekly: a late send hour holds the digest back until that hour", () => {
    expect(shouldSendDigest("weekly", new Date("2026-08-17T22:59:59.999Z"), 23)).toBe(false);
    expect(shouldSendDigest("weekly", new Date("2026-08-17T23:00:00.000Z"), 23)).toBe(true);
  });

  it("monthly: gated on the send hour of the first day of the new month", () => {
    expect(shouldSendDigest("monthly", new Date("2026-08-01T06:00:00.000Z"), 7)).toBe(false);
    expect(shouldSendDigest("monthly", new Date("2026-08-01T07:00:00.000Z"), 7)).toBe(true);
    expect(shouldSendDigest("monthly", new Date("2026-08-20T02:00:00.000Z"), 7)).toBe(true);
  });

  it("is total for an out-of-range hour rather than producing a nonsense instant", () => {
    // Clamped to 23 / 0 — a caller that bypassed the schema still gets a bool.
    expect(shouldSendDigest("weekly", new Date("2026-08-17T23:00:00.000Z"), 99)).toBe(true);
    expect(shouldSendDigest("weekly", new Date("2026-08-17T00:00:00.000Z"), -5)).toBe(true);
    expect(shouldSendDigest("weekly", new Date("2026-08-17T00:00:00.000Z"), Number.NaN)).toBe(true);
  });
});

describe("reportDigestDedupKey", () => {
  it("encodes (tenant, recipient, cadence, closed period) — this key IS the idempotency mechanism", () => {
    expect(reportDigestDedupKey("tenant-1", "cfo@acme.com", "weekly", "2026-W33")).toBe(
      "report_digest:tenant-1:cfo@acme.com:weekly:2026-W33",
    );
    expect(reportDigestDedupKey("tenant-1", "cfo@acme.com", "monthly", "2026-07")).toBe(
      "report_digest:tenant-1:cfo@acme.com:monthly:2026-07",
    );
  });

  it("cadence is in the key, so switching cadence cannot collide with a sent digest", () => {
    const period = digestPeriod("weekly", new Date("2026-08-18T09:00:00.000Z"));
    const monthly = digestPeriod("monthly", new Date("2026-08-18T09:00:00.000Z"));
    expect(reportDigestDedupKey("t", "a@b.com", "weekly", period.periodKey)).not.toBe(
      reportDigestDedupKey("t", "a@b.com", "monthly", monthly.periodKey),
    );
  });

  // The regression this pins: notification_outbox's dedup index is UNIQUE
  // (tenant_id, dedup_key). A key without the recipient leg means recipient #1
  // inserts and everyone else 23505s into a silent "already sent" — a tenant
  // with three configured addresses would get exactly one email.
  it("distinguishes recipients, so a multi-recipient digest actually fans out", () => {
    const keys = ["cfo@acme.com", "chro@acme.com", "ceo@acme.com"].map((r) =>
      reportDigestDedupKey("tenant-1", r, "weekly", "2026-W33"),
    );
    expect(new Set(keys).size).toBe(3);
  });
});
