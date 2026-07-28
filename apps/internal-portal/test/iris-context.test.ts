import { describe, expect, it } from "vitest";
import { suggestedActionForRoute, deriveIrisContext } from "../src/components/iris/context-map";

/**
 * IRIS-A2 — the route → suggested-action map is pure routing sugar; it must map
 * the known surfaces to the one whitelisted action and suggest nothing
 * elsewhere. DB-free.
 */
describe("suggestedActionForRoute", () => {
  it("suggests create_requisition_jd on the requisitions surface (and children)", () => {
    expect(suggestedActionForRoute("/requisitions")).toBe("create_requisition_jd");
    expect(suggestedActionForRoute("/requisitions/new")).toBe("create_requisition_jd");
    expect(suggestedActionForRoute("/requisitions/")).toBe("create_requisition_jd");
  });

  it("suggests create_requisition_jd on the dashboard", () => {
    expect(suggestedActionForRoute("/dashboard")).toBe("create_requisition_jd");
  });

  it("suggests nothing on an unmapped route (the default)", () => {
    expect(suggestedActionForRoute("/candidates")).toBeNull();
    expect(suggestedActionForRoute("/admin/costs")).toBeNull();
    expect(suggestedActionForRoute("/")).toBeNull();
    // A route that only shares a name PREFIX must not match.
    expect(suggestedActionForRoute("/requisitions-archive")).toBeNull();
  });
});

describe("deriveIrisContext", () => {
  it("carries the normalised route and no entity for a plain surface", () => {
    expect(deriveIrisContext("/requisitions")).toEqual({ route: "/requisitions" });
  });

  it("extracts the trivial requisition-detail entity", () => {
    const ctx = deriveIrisContext("/requisitions/2f1c9d0a-1234-4abc-8def-0123456789ab");
    expect(ctx).toEqual({
      route: "/requisitions/2f1c9d0a-1234-4abc-8def-0123456789ab",
      entityType: "requisition",
      entityId: "2f1c9d0a-1234-4abc-8def-0123456789ab",
    });
  });
});
