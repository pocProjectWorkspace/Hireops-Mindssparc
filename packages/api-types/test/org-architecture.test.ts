/**
 * C1-F3 — pure unit tests for the tenant-lookup resolver, the PC-17 renege
 * fallback, job-profile pre-fill and comp-band scoping. No DB.
 */

import { describe, expect, it } from "vitest";
import {
  PLATFORM_LOOKUP_DEFAULTS,
  PLATFORM_RENEGE_REASONS,
  TENANT_LOOKUP_KINDS,
  compBandsForScope,
  createLocationInputSchema,
  jobProfilePrefill,
  levelWithinProfileRange,
  lookupLabel,
  resolveRenegeReasons,
  resolveTenantLookup,
  upsertTenantLookupInputSchema,
  type JobFunctionRow,
  type JobLevelRow,
  type JobProfileRow,
  type TenantLookupRowInput,
} from "../src";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(
  p: Partial<TenantLookupRowInput> & { kind: string; key: string },
): TenantLookupRowInput {
  return {
    id: ID(900),
    label: p.key,
    sortOrder: 0,
    isActive: true,
    attrs: {},
    ...p,
  };
}

describe("tenant lookup resolver", () => {
  it("every kind has a non-empty platform default list with unique keys", () => {
    for (const kind of TENANT_LOOKUP_KINDS) {
      const list = PLATFORM_LOOKUP_DEFAULTS[kind];
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((d) => d.key)).size).toBe(list.length);
    }
  });

  it("resolves platform defaults when the tenant has no rows", () => {
    const r = resolveTenantLookup("requisition_type", []);
    expect(r.map((e) => e.key)).toEqual(["new", "replacement", "investment"]);
    expect(r.every((e) => e.source === "platform" && e.rowId === null && e.isActive)).toBe(true);
    const emp = resolveTenantLookup("employment_type", []);
    expect(emp.find((e) => e.key === "contract")?.attrs).toEqual({
      hasDuration: true,
      defaultDurationMonths: 12,
    });
  });

  it("a tenant row with a platform key overrides label / order / active / attrs", () => {
    const r = resolveTenantLookup("employment_type", [
      row({
        id: ID(1),
        kind: "employment_type",
        key: "contract",
        label: "Contractor (fixed duration)",
        sortOrder: 5,
        attrs: { defaultDurationMonths: 6 },
      }),
      row({
        kind: "employment_type",
        key: "intern",
        label: "Intern",
        sortOrder: 40,
        isActive: false,
      }),
    ]);
    const contract = r[0];
    expect(contract?.key).toBe("contract");
    expect(contract?.label).toBe("Contractor (fixed duration)");
    expect(contract?.source).toBe("override");
    expect(contract?.rowId).toBe(ID(1));
    expect(contract?.platformLabel).toBe("Contract");
    // attrs merge over the platform attrs
    expect(contract?.attrs).toEqual({ hasDuration: true, defaultDurationMonths: 6 });
    expect(r.find((e) => e.key === "intern")?.isActive).toBe(false);
    expect(
      resolveTenantLookup(
        "employment_type",
        [row({ kind: "employment_type", key: "intern", isActive: false })],
        { activeOnly: true },
      ).some((e) => e.key === "intern"),
    ).toBe(false);
  });

  it("a new key adds a tenant-only value; other kinds' rows are ignored; corrupt attrs resolve to {}", () => {
    const r = resolveTenantLookup("requisition_type", [
      row({
        kind: "requisition_type",
        key: "backfill_leave",
        label: "Leave cover",
        sortOrder: 25,
        attrs: null,
      }),
      row({ kind: "asset_type", key: "new", label: "Should not appear" }),
    ]);
    expect(r.map((e) => e.key)).toEqual(["new", "replacement", "backfill_leave", "investment"]);
    const added = r.find((e) => e.key === "backfill_leave");
    expect(added?.source).toBe("tenant");
    expect(added?.platformLabel).toBeNull();
    expect(added?.attrs).toEqual({});
    expect(r.find((e) => e.key === "new")?.label).toBe("New headcount");
  });

  it("lookupLabel falls back to the raw key for an unknown / retired value", () => {
    const r = resolveTenantLookup("requisition_type", []);
    expect(lookupLabel(r, "replacement")).toBe("Replacement");
    expect(lookupLabel(r, "gone_value")).toBe("gone_value");
    expect(lookupLabel(r, null)).toBeNull();
  });

  it("upsert input validates key format and flat attrs", () => {
    expect(
      upsertTenantLookupInputSchema.safeParse({ kind: "asset_type", key: "Laptop!", label: "x" })
        .success,
    ).toBe(false);
    expect(
      upsertTenantLookupInputSchema.safeParse({
        kind: "asset_type",
        key: "dock",
        label: "Docking station",
        attrs: { nested: { a: 1 } },
      }).success,
    ).toBe(false);
    const ok = upsertTenantLookupInputSchema.parse({
      kind: "asset_type",
      key: "dock",
      label: "Dock",
    });
    expect(ok.isActive).toBe(true);
    expect(ok.attrs).toEqual({});
  });
});

describe("PC-17 renege reasons through the lookup", () => {
  const settingsReasons = [
    { code: "counter_offer", label: "Took a counter-offer" },
    { code: "other", label: "Other" },
  ];

  it("no renege_reason rows → exactly the tenant's existing setting list", () => {
    expect(resolveRenegeReasons(settingsReasons, [])).toEqual(settingsReasons);
    expect(resolveRenegeReasons(PLATFORM_RENEGE_REASONS, [])).toEqual(PLATFORM_RENEGE_REASONS);
    // rows of other kinds don't change anything
    expect(resolveRenegeReasons(settingsReasons, [row({ kind: "asset_type", key: "x" })])).toEqual(
      settingsReasons,
    );
  });

  it("lookup rows override / add / deactivate on top of the setting list", () => {
    const r = resolveRenegeReasons(settingsReasons, [
      row({ kind: "renege_reason", key: "counter_offer", label: "Counter-offer", sortOrder: 10 }),
      row({ kind: "renege_reason", key: "other", isActive: false }),
      row({
        kind: "renege_reason",
        key: "gcc_competitor",
        label: "Joined another GCC",
        sortOrder: 15,
      }),
    ]);
    expect(r).toEqual([
      { code: "counter_offer", label: "Counter-offer" },
      { code: "gcc_competitor", label: "Joined another GCC" },
    ]);
  });

  it("deactivating everything falls back to the setting list (never empty)", () => {
    const r = resolveRenegeReasons(settingsReasons, [
      row({ kind: "renege_reason", key: "counter_offer", isActive: false }),
      row({ kind: "renege_reason", key: "other", isActive: false }),
    ]);
    expect(r).toEqual(settingsReasons);
  });
});

const fns: JobFunctionRow[] = [
  { id: ID(11), key: "finance", label: "Finance", sortOrder: 10, isActive: true },
  { id: ID(12), key: "hr", label: "Human Resources", sortOrder: 20, isActive: true },
];
const levels: JobLevelRow[] = [
  { id: ID(23), key: "L3", label: "Level 3", rank: 30, isActive: true },
  { id: ID(21), key: "L1", label: "Level 1", rank: 10, isActive: true },
  { id: ID(22), key: "L2", label: "Level 2", rank: 20, isActive: false },
  { id: ID(24), key: "L4", label: "Level 4", rank: 40, isActive: true },
];
function profile(p: Partial<JobProfileRow>): JobProfileRow {
  return {
    id: ID(31),
    title: "Accounts Payable Analyst",
    jobFunctionId: ID(11),
    jobLevelMinId: null,
    jobLevelMaxId: null,
    defaultJdTemplateId: null,
    competencies: [
      { key: "reconciliation", label: "Reconciliation" },
      { key: "month_end_close", label: "Month-end close" },
    ],
    canonicalMarketTitle: null,
    isActive: true,
    ...p,
  };
}

describe("job profile pre-fill", () => {
  it("fills title, function, lowest level of the range and competencies", () => {
    const p = jobProfilePrefill(profile({ jobLevelMinId: ID(21), jobLevelMaxId: ID(23) }), {
      jobFunctions: fns,
      jobLevels: levels,
    });
    expect(p.title).toBe("Accounts Payable Analyst");
    expect(p.jobFunctionId).toBe(ID(11));
    expect(p.functionLabel).toBe("Finance");
    expect(p.jobLevelId).toBe(ID(21));
    expect(p.seniorityLabel).toBe("Level 1");
    // range L1..L3, inactive L2 excluded, ordered by rank
    expect(p.allowedLevelIds).toEqual([ID(21), ID(23)]);
    expect(p.competencies.map((c) => c.key)).toEqual(["reconciliation", "month_end_close"]);
  });

  it("a profile without a range allows every active level and pre-fills none", () => {
    const p = jobProfilePrefill(profile({ jobFunctionId: null }), {
      jobFunctions: fns,
      jobLevels: levels,
    });
    expect(p.jobLevelId).toBeNull();
    expect(p.jobFunctionId).toBeNull();
    expect(p.allowedLevelIds).toEqual([ID(21), ID(23), ID(24)]);
  });

  it("a max-only range pre-fills the max and allows everything at or below it", () => {
    const p = jobProfilePrefill(profile({ jobLevelMaxId: ID(23) }), {
      jobFunctions: fns,
      jobLevels: levels,
    });
    expect(p.jobLevelId).toBe(ID(23));
    expect(p.allowedLevelIds).toEqual([ID(21), ID(23)]);
  });

  it("levelWithinProfileRange respects open bounds and unknown ids", () => {
    const pr = profile({ jobLevelMinId: ID(23) });
    expect(levelWithinProfileRange(pr, ID(24), levels)).toBe(true);
    expect(levelWithinProfileRange(pr, ID(21), levels)).toBe(false);
    expect(levelWithinProfileRange(pr, ID(99), levels)).toBe(false);
    expect(levelWithinProfileRange(profile({}), ID(21), levels)).toBe(true);
  });
});

describe("comp band scoping", () => {
  const LV = ID(21);
  const FN = ID(11);
  const LOC = ID(41);
  const bands = [
    { id: "any", jobLevelId: null, jobFunctionId: null, locationId: null },
    { id: "lv", jobLevelId: LV, jobFunctionId: null, locationId: null },
    { id: "lv-fn-loc", jobLevelId: LV, jobFunctionId: FN, locationId: LOC },
    { id: "lv-loc", jobLevelId: LV, jobFunctionId: null, locationId: LOC },
    { id: "other-lv", jobLevelId: ID(24), jobFunctionId: null, locationId: null },
  ];

  it("most specific first; unscoped dimensions match anything", () => {
    expect(
      compBandsForScope(bands, { jobLevelId: LV, jobFunctionId: FN, locationId: LOC }).map(
        (b) => b.id,
      ),
    ).toEqual(["lv-fn-loc", "lv-loc", "lv", "any"]);
  });

  it("a missing context value only matches bands unscoped on that dimension", () => {
    expect(compBandsForScope(bands, { jobLevelId: LV }).map((b) => b.id)).toEqual(["lv", "any"]);
    expect(compBandsForScope(bands, {}).map((b) => b.id)).toEqual(["any"]);
  });
});

describe("location input", () => {
  it("upper-cases the country, validates IANA zones, blanks to null", () => {
    const ok = createLocationInputSchema.parse({
      name: "Hyderabad",
      city: "Hyderabad",
      region: "",
      countryCode: "in",
      timezone: "Asia/Kolkata",
    });
    expect(ok.countryCode).toBe("IN");
    expect(ok.region).toBeNull();
    expect(createLocationInputSchema.safeParse({ name: "X", countryCode: "IND" }).success).toBe(
      false,
    );
    expect(
      createLocationInputSchema.safeParse({ name: "X", countryCode: "IN", timezone: "Mars/Base" })
        .success,
    ).toBe(false);
  });
});
