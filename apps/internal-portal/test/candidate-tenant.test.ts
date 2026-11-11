import { describe, expect, it } from "vitest";
import { resolveCandidateTenantSlug } from "@/lib/candidate-tenant";

/** C1-BUGS BUG-13 — candidate activation tenant: route → ?tenant → deployment env → none. */
describe("resolveCandidateTenantSlug", () => {
  it("the route slug wins", () => {
    expect(
      resolveCandidateTenantSlug({
        routeSlug: "acme",
        querySlug: "other",
        deploymentDefault: "dep",
      }),
    ).toBe("acme");
  });
  it("then ?tenant=, then the deployment default", () => {
    expect(resolveCandidateTenantSlug({ querySlug: "Other", deploymentDefault: "dep" })).toBe(
      "other",
    );
    expect(resolveCandidateTenantSlug({ deploymentDefault: " dep-1 " })).toBe("dep-1");
  });
  it("nothing configured → null, never a client slug", () => {
    expect(resolveCandidateTenantSlug({})).toBeNull();
    expect(resolveCandidateTenantSlug({ routeSlug: "", querySlug: "  " })).toBeNull();
  });
  it("malformed slugs are ignored", () => {
    expect(resolveCandidateTenantSlug({ querySlug: "../evil", deploymentDefault: "ok-slug" })).toBe(
      "ok-slug",
    );
  });
});
