import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { resolveEffectivePermissions } from "@hireops/api-types";
import { capsAllow } from "../src/lib/nav-capabilities";

/** C2-F1 — the nav capability rule (display only; the API enforces). */
describe("capsAllow", () => {
  const recruiter = resolveEffectivePermissions({ roles: ["recruiter"], customRole: null }).caps;
  const admin = resolveEffectivePermissions({ roles: ["admin"], customRole: null }).caps;

  it("un-gated items always show, even signed out", () => {
    assert.equal(capsAllow(null, undefined), true);
    assert.equal(capsAllow(null, []), true);
  });

  it("gated items need ANY of the capabilities; signed out sees none", () => {
    assert.equal(capsAllow(recruiter, ["candidates.triage"]), true);
    assert.equal(capsAllow(recruiter, ["partners.admin"]), false);
    assert.equal(capsAllow(recruiter, ["partners.admin", "interviews.manage"]), true);
    assert.equal(capsAllow(null, ["candidates.triage"]), false);
  });

  it("admin sees admin items through its bundle; a custom bundle without them does not", () => {
    assert.equal(capsAllow(admin, ["admin.console"]), true);
    const custom = resolveEffectivePermissions({
      roles: ["admin"],
      customRole: {
        key: "it_lead",
        baseRole: "admin",
        active: true,
        grants: [{ capability: "settings.branding", scope: "all" }],
      },
    }).caps;
    assert.equal(capsAllow(custom, ["admin.console"]), false);
    assert.equal(capsAllow(custom, ["settings.branding"]), true);
  });
});
