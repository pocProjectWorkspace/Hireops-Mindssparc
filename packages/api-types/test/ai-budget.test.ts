import { describe, expect, it } from "vitest";
import {
  AI_BUDGET_VERSION,
  USD_MICROS,
  defaultAiBudget,
  resolveAiBudget,
  monthlyBudgetMicros,
  projectMonthEndSpendMicros,
  deriveAiBudgetStatus,
  crossedAiBudgetThresholds,
  aiBudgetAlertDedupKey,
} from "../src/admin-ops";

/**
 * T5.1 / G24 — AI budget + spend alerts.
 *
 * Honesty focus: the tenant AI-budget block is not decorative. These are the
 * PURE decision functions that the two real consumers delegate to:
 *   - getAiBudgetStatus (server-computed costs projection) uses
 *     projectMonthEndSpendMicros + deriveAiBudgetStatus + monthlyBudgetMicros.
 *   - the ai_budget_scan worker uses crossedAiBudgetThresholds +
 *     aiBudgetAlertDedupKey to decide which per-threshold alerts to enqueue.
 * resolveAiBudget provides the resolve-over-defaults discipline (never throws;
 * an unconfigured tenant is byte-identical to alerting-off).
 *
 * Kept pure (no DB) so the honesty core is covered without live-DB flake; the
 * worker's additional enabled/emailAlerts gate is a plain boolean guard over
 * these same helpers.
 */

describe("resolveAiBudget", () => {
  it("empty block resolves to the disabled defaults (unconfigured = alerting off)", () => {
    expect(resolveAiBudget({})).toEqual({
      version: AI_BUDGET_VERSION,
      enabled: false,
      monthlyBudgetUsd: 0,
      alertThresholdPercents: [80, 100],
    });
    expect(resolveAiBudget(undefined)).toEqual(defaultAiBudget());
    expect(resolveAiBudget(null)).toEqual(defaultAiBudget());
  });

  it("merges a partial block over defaults", () => {
    const r = resolveAiBudget({ enabled: true, monthlyBudgetUsd: 500 });
    expect(r.enabled).toBe(true);
    expect(r.monthlyBudgetUsd).toBe(500);
    expect(r.alertThresholdPercents).toEqual([80, 100]);
  });

  it("dedups and sorts the threshold list ascending", () => {
    expect(
      resolveAiBudget({ alertThresholdPercents: [100, 80, 80, 50] }).alertThresholdPercents,
    ).toEqual([50, 80, 100]);
  });

  it("malformed values fall back to defaults rather than throwing", () => {
    expect(resolveAiBudget({ monthlyBudgetUsd: "lots" })).toEqual(defaultAiBudget());
    // A single out-of-range threshold (>200) invalidates the block → safe defaults.
    expect(resolveAiBudget({ alertThresholdPercents: [80, 300] })).toEqual(defaultAiBudget());
    expect(resolveAiBudget("garbage")).toEqual(defaultAiBudget());
  });
});

describe("monthlyBudgetMicros", () => {
  it("converts whole and fractional USD to micros", () => {
    expect(monthlyBudgetMicros(500)).toBe(500n * BigInt(USD_MICROS));
    expect(monthlyBudgetMicros(0.5)).toBe(500_000n);
    expect(monthlyBudgetMicros(0)).toBe(0n);
  });

  it("clamps negatives to zero", () => {
    expect(monthlyBudgetMicros(-5)).toBe(0n);
  });
});

describe("projectMonthEndSpendMicros", () => {
  it("linearly extrapolates the month-to-date daily rate", () => {
    // 15 Jan 2026 (31-day month): $1.50 in 15 days → $3.10 projected.
    const jan15 = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(projectMonthEndSpendMicros(1_500_000n, jan15)).toBe(3_100_000n);
  });

  it("does not divide by zero on day 1", () => {
    const day1 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    // daysElapsed = 1, daysInMonth = 31 → projection = mtd × 31.
    expect(projectMonthEndSpendMicros(1_000_000n, day1)).toBe(31_000_000n);
  });
});

describe("deriveAiBudgetStatus", () => {
  const budgetUsd = 100; // = 100_000_000 micros

  it("is off when disabled or no budget", () => {
    expect(
      deriveAiBudgetStatus({
        enabled: false,
        monthlyBudgetUsd: budgetUsd,
        projectedMicros: 50_000_000n,
      }),
    ).toBe("off");
    expect(
      deriveAiBudgetStatus({ enabled: true, monthlyBudgetUsd: 0, projectedMicros: 50_000_000n }),
    ).toBe("off");
  });

  it("over_projected when the projection exceeds budget", () => {
    expect(
      deriveAiBudgetStatus({
        enabled: true,
        monthlyBudgetUsd: budgetUsd,
        projectedMicros: 150_000_000n,
      }),
    ).toBe("over_projected");
  });

  it("on_track at/over the 80% band, under below it", () => {
    expect(
      deriveAiBudgetStatus({
        enabled: true,
        monthlyBudgetUsd: budgetUsd,
        projectedMicros: 80_000_000n,
      }),
    ).toBe("on_track");
    expect(
      deriveAiBudgetStatus({
        enabled: true,
        monthlyBudgetUsd: budgetUsd,
        projectedMicros: 85_000_000n,
      }),
    ).toBe("on_track");
    expect(
      deriveAiBudgetStatus({
        enabled: true,
        monthlyBudgetUsd: budgetUsd,
        projectedMicros: 50_000_000n,
      }),
    ).toBe("under");
  });
});

describe("crossedAiBudgetThresholds", () => {
  const budgetUsd = 100; // 100_000_000 micros; 80% = 80_000_000, 100% = 100_000_000

  it("returns the thresholds MTD has reached, fires at the exact mark", () => {
    expect(crossedAiBudgetThresholds(90_000_000n, budgetUsd, [80, 100])).toEqual([80]);
    expect(crossedAiBudgetThresholds(100_000_000n, budgetUsd, [80, 100])).toEqual([80, 100]);
    // At the exact 80% micros the mark fires (never late).
    expect(crossedAiBudgetThresholds(80_000_000n, budgetUsd, [80, 100])).toEqual([80]);
  });

  it("returns nothing below the lowest threshold", () => {
    expect(crossedAiBudgetThresholds(50_000_000n, budgetUsd, [80, 100])).toEqual([]);
  });

  it("returns nothing when no budget is set (the worker also gates on enabled)", () => {
    expect(crossedAiBudgetThresholds(999_000_000n, 0, [80, 100])).toEqual([]);
  });
});

describe("aiBudgetAlertDedupKey", () => {
  it("encodes (tenant, month, percent) — one alert per threshold per month", () => {
    expect(aiBudgetAlertDedupKey("tenant-1", "2026-07", 80)).toBe("ai_budget:tenant-1:2026-07:80");
  });
});
