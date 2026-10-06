import { describe, expect, it } from "vitest";
import { resolveLandingHref, resolveSystemSetup } from "../src/admin-ops";

describe("resolveLandingHref", () => {
  it("lands everyone on the dashboard when nothing is configured", () => {
    const setup = resolveSystemSetup({});
    expect(resolveLandingHref(setup, ["admin"])).toBe("/dashboard");
    expect(resolveLandingHref(setup, ["recruiter"])).toBe("/dashboard");
  });

  it("uses the configured page for the role", () => {
    const setup = resolveSystemSetup({ landingPages: { admin: "metrics" } });
    expect(resolveLandingHref(setup, ["admin"])).toBe("/metrics");
    expect(resolveLandingHref(setup, ["recruiter"])).toBe("/dashboard");
  });

  it("takes the first role in precedence order that has a page set", () => {
    const setup = resolveSystemSetup({
      landingPages: { recruiter: "triage", hiring_manager: "requisitions" },
    });
    expect(resolveLandingHref(setup, ["hiring_manager", "recruiter"])).toBe("/triage");
  });

  it("falls back to defaults when the stored block holds an unknown page", () => {
    const setup = resolveSystemSetup({ landingPages: { admin: "https://evil.example" } });
    expect(resolveLandingHref(setup, ["admin"])).toBe("/dashboard");
  });
});
