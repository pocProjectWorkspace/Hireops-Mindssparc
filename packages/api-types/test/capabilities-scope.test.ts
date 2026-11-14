/**
 * C2-F1 — scope evaluation (P5 target populations) + custom-role resolution.
 * Pure: no DB.
 */
import { describe, expect, it } from "vitest";
import {
  customRoleKeySchema,
  populationFor,
  recordInPopulation,
  resolveEffectivePermissions,
  validateGrants,
  widerScope,
  type PopulationFacts,
} from "../src/capabilities";

const ME = "m-me";
const REPORT = "m-report";
const OTHER = "m-other";

const facts: PopulationFacts = {
  membershipId: ME,
  directReportIds: [REPORT],
  businessUnitSubtreeIds: ["bu-fin", "bu-fin-ap"],
  legalEntityBusinessUnitIds: ["bu-fin", "bu-fin-ap", "bu-ops"],
};

const rec = (owners: (string | null)[], bu: string | null) => ({
  ownerMembershipIds: owners,
  businessUnitId: bu,
});

describe("populationFor / recordInPopulation", () => {
  it("all — everything", () => {
    const p = populationFor("all", facts);
    expect(p).toEqual({ kind: "all" });
    expect(recordInPopulation(p, rec([OTHER], null))).toBe(true);
  });

  it("own — only records the member owns", () => {
    const p = populationFor("own", facts);
    expect(recordInPopulation(p, rec([ME, null], "bu-x"))).toBe(true);
    expect(recordInPopulation(p, rec([null, ME], "bu-x"))).toBe(true);
    expect(recordInPopulation(p, rec([REPORT], "bu-fin"))).toBe(false);
    expect(recordInPopulation(p, rec([OTHER], "bu-fin"))).toBe(false);
  });

  it("team — own + direct reports", () => {
    const p = populationFor("team", facts);
    expect(recordInPopulation(p, rec([ME], null))).toBe(true);
    expect(recordInPopulation(p, rec([REPORT], null))).toBe(true);
    expect(recordInPopulation(p, rec([OTHER], null))).toBe(false);
  });

  it("business_unit — the member's unit and below", () => {
    const p = populationFor("business_unit", facts);
    expect(recordInPopulation(p, rec([OTHER], "bu-fin-ap"))).toBe(true);
    expect(recordInPopulation(p, rec([ME], "bu-ops"))).toBe(false);
    expect(recordInPopulation(p, rec([ME], null))).toBe(false);
  });

  it("legal_entity — every unit of the member's entity", () => {
    const p = populationFor("legal_entity", facts);
    expect(recordInPopulation(p, rec([OTHER], "bu-ops"))).toBe(true);
    expect(recordInPopulation(p, rec([OTHER], "bu-elsewhere"))).toBe(false);
  });

  it("fails closed: no membership / no business unit → nothing, never everything", () => {
    const none: PopulationFacts = {
      membershipId: null,
      directReportIds: [],
      businessUnitSubtreeIds: [],
      legalEntityBusinessUnitIds: [],
    };
    for (const s of ["own", "team", "business_unit", "legal_entity"] as const) {
      const p = populationFor(s, none);
      expect(recordInPopulation(p, rec([null], null)), s).toBe(false);
      expect(recordInPopulation(p, rec(["anyone"], "any-bu")), s).toBe(false);
    }
  });

  it("widerScope orders own < team < business_unit < legal_entity < all", () => {
    expect(widerScope("own", "all")).toBe("all");
    expect(widerScope("team", "own")).toBe("team");
    expect(widerScope("business_unit", "legal_entity")).toBe("legal_entity");
  });
});

describe("resolveEffectivePermissions — custom roles", () => {
  it("a custom role grants ONLY its bundle (no inheritance from the base role)", () => {
    const p = resolveEffectivePermissions({
      roles: ["admin"],
      customRole: {
        key: "it_lead",
        baseRole: "admin",
        active: true,
        grants: [{ capability: "admin.users", scope: "all" }],
      },
    });
    expect(p.roleKey).toBe("it_lead");
    expect(p.caps).toEqual({ "admin.users": "all" });
    expect(p.caps["offers.comp_desk"]).toBeUndefined();
    expect(p.sourceRoles["admin.users"]).toEqual(["admin"]);
  });

  it("an inactive custom role grants nothing (fail closed)", () => {
    const p = resolveEffectivePermissions({
      roles: ["recruiter"],
      customRole: {
        key: "x_role",
        baseRole: "recruiter",
        active: false,
        grants: [{ capability: "candidates.triage", scope: "all" }],
      },
    });
    expect(p.caps).toEqual({});
  });

  it("drops unknown capabilities and disallowed scopes", () => {
    const p = resolveEffectivePermissions({
      roles: [],
      customRole: {
        key: "x_role",
        baseRole: "recruiter",
        active: true,
        grants: [
          { capability: "made.up", scope: "all" },
          { capability: "settings.branding", scope: "own" },
          { capability: "requisitions.read", scope: "business_unit" },
          { capability: "candidates.triage", scope: "galaxy" },
        ],
      },
    });
    expect(p.caps).toEqual({ "requisitions.read": "business_unit" });
  });

  it("no custom role → system bundles of the JWT roles", () => {
    const p = resolveEffectivePermissions({ roles: ["hiring_manager"], customRole: null });
    expect(p.roleKey).toBeNull();
    expect(p.caps["requisitions.write"]).toBe("all");
    expect(p.caps["requisitions.owner_insights"]).toBe("own");
    expect(p.caps["candidates.triage"]).toBeUndefined();
  });
});

describe("custom role validation", () => {
  it("rejects system keys and malformed keys", () => {
    expect(customRoleKeySchema.safeParse("admin").success).toBe(false);
    expect(customRoleKeySchema.safeParse("Bad-Key").success).toBe(false);
    expect(customRoleKeySchema.safeParse("ta_lead").success).toBe(true);
  });

  it("validateGrants rejects a scope the capability does not have, and duplicates", () => {
    expect(validateGrants([{ capability: "settings.branding", scope: "own" }])).toMatch(/Scope/);
    expect(
      validateGrants([
        { capability: "reports.read", scope: "all" },
        { capability: "reports.read", scope: "all" },
      ]),
    ).toMatch(/Duplicate/);
    expect(validateGrants([{ capability: "requisitions.read", scope: "team" }])).toBeNull();
  });
});
