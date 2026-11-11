import { describe, expect, it } from "vitest";
import { resolveTenantModules, type PlatformModuleKey } from "@hireops/api-types";
import { filterNavByModules, isNavModuleVisible } from "../src/lib/nav-modules";

/**
 * C1-F10 (D4) — module-disabled surfaces are hidden from the nav. The items
 * mirror AppShell's module tags (AppShell itself is .tsx, which this vitest
 * setup does not transform; NavItem.module is type-checked against the
 * catalogue at compile time).
 */
const ITEMS: { key: string; module?: PlatformModuleKey }[] = [
  { key: "home" },
  { key: "triage" },
  { key: "onboarding", module: "onboarding" },
  { key: "joining-watchlist", module: "pre_joining_engagement" },
  { key: "ask-data", module: "ask_data" },
  { key: "market-intelligence", module: "market_intel" },
  { key: "availability", module: "scheduling" },
  { key: "partners", module: "partner_portal" },
  { key: "scheduling-settings", module: "scheduling" },
  { key: "diversity-slate", module: "diversity_slate" },
  { key: "learning", module: "learning" },
  { key: "pre-joining", module: "pre_joining_engagement" },
  { key: "welcome-content", module: "welcome_guide" },
];

describe("nav module gating", () => {
  it("shows everything when entitlements are unknown (signed out / failed read)", () => {
    expect(filterNavByModules(ITEMS, null)).toHaveLength(ITEMS.length);
  });

  it("shows everything for a tenant with no tenant_modules rows (existing tenants)", () => {
    expect(filterNavByModules(ITEMS, resolveTenantModules([]))).toHaveLength(ITEMS.length);
  });

  it("hides exactly the items of a disabled module", () => {
    const modules = resolveTenantModules([
      { moduleKey: "ask_data", enabled: false },
      { moduleKey: "pre_joining_engagement", enabled: false },
    ]);
    const keys = filterNavByModules(ITEMS, modules).map((i) => i.key);
    expect(keys).not.toContain("ask-data");
    expect(keys).not.toContain("joining-watchlist");
    expect(keys).not.toContain("pre-joining");
    expect(keys).toContain("home");
    expect(keys).toContain("onboarding");
    expect(keys).toContain("welcome-content");
    expect(ITEMS.length - keys.length).toBe(3);
  });

  it("an explicit enable keeps the item; unknown DB keys are ignored", () => {
    const modules = resolveTenantModules([
      { moduleKey: "ask_data", enabled: true },
      { moduleKey: "not_a_module", enabled: false },
    ]);
    expect(isNavModuleVisible(modules, "ask_data")).toBe(true);
    expect(filterNavByModules(ITEMS, modules)).toHaveLength(ITEMS.length);
  });
});
