import { describe, expect, it } from "vitest";
import {
  IRIS_POLICY_VERSION,
  defaultIrisPolicy,
  resolveIrisPolicy,
  irisActionAllowedRoles,
} from "../src/iris";

/**
 * T-POLICY — per-role Iris action policy (DENY-OVERLAY).
 *
 * Honesty focus: the policy can only ever NARROW each action's baked-in static
 * roles, never widen them, and an UNCONFIGURED tenant (absent / malformed block)
 * resolves to the empty overlay — byte-identical to today's behaviour. These are
 * the PURE decision functions the four Iris call sites delegate to; kept DB-free
 * so the honesty core is covered without live-DB flake.
 */

describe("resolveIrisPolicy", () => {
  it("unconfigured (undefined / null / empty) resolves to the empty overlay", () => {
    const empty = { version: IRIS_POLICY_VERSION, disabledRoles: {} };
    expect(resolveIrisPolicy(undefined)).toEqual(empty);
    expect(resolveIrisPolicy(undefined)).toEqual(defaultIrisPolicy());
    expect(resolveIrisPolicy(null)).toEqual(defaultIrisPolicy());
    expect(resolveIrisPolicy({})).toEqual(defaultIrisPolicy());
  });

  it("malformed / future block falls back to defaults rather than throwing (never widens)", () => {
    expect(resolveIrisPolicy({ version: "iris-policy-v999" })).toEqual(defaultIrisPolicy());
    expect(resolveIrisPolicy({ disabledRoles: "nonsense" })).toEqual(defaultIrisPolicy());
    expect(resolveIrisPolicy(42)).toEqual(defaultIrisPolicy());
  });

  it("preserves a valid deny-overlay verbatim", () => {
    const raw = {
      version: IRIS_POLICY_VERSION,
      disabledRoles: { reject_application: ["recruiter"] },
    };
    expect(resolveIrisPolicy(raw)).toEqual(raw);
  });
});

describe("irisActionAllowedRoles", () => {
  const staticRoles = ["admin", "recruiter", "hr_ops"];

  it("empty overlay leaves the static roles untouched", () => {
    expect(irisActionAllowedRoles("reject_application", staticRoles, defaultIrisPolicy())).toEqual(
      staticRoles,
    );
  });

  it("removes ONLY the disabled roles for that action (order preserved)", () => {
    const policy = resolveIrisPolicy({
      version: IRIS_POLICY_VERSION,
      disabledRoles: { reject_application: ["recruiter"] },
    });
    expect(irisActionAllowedRoles("reject_application", staticRoles, policy)).toEqual([
      "admin",
      "hr_ops",
    ]);
    // A DIFFERENT action id is untouched by that entry.
    expect(irisActionAllowedRoles("advance_application", staticRoles, policy)).toEqual(staticRoles);
  });

  it("a disabled role that is NOT in the static set is a no-op (can never widen)", () => {
    const policy = resolveIrisPolicy({
      version: IRIS_POLICY_VERSION,
      disabledRoles: { reject_application: ["panel_member"] },
    });
    expect(irisActionAllowedRoles("reject_application", staticRoles, policy)).toEqual(staticRoles);
  });

  it("disabling every static role yields an empty set (nobody may run it)", () => {
    const policy = resolveIrisPolicy({
      version: IRIS_POLICY_VERSION,
      disabledRoles: { reject_application: [...staticRoles] },
    });
    expect(irisActionAllowedRoles("reject_application", staticRoles, policy)).toEqual([]);
  });
});
