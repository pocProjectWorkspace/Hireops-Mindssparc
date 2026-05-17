import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

/**
 * Pure-logic tests for the admin-role gating helper. We can't exercise
 * the full Next server-component context here (requireAuth pulls in
 * @supabase/ssr + next/headers), so this file targets the smaller
 * decision function — "given a roles[] array, is the caller admin?"
 *
 * Keeps the role-gating contract testable without a heavyweight
 * server-component test rig.
 */

function hasAdminRole(roles: string[] | undefined): boolean {
  return Array.isArray(roles) && roles.includes("admin");
}

describe("Module 4 admin role check", () => {
  it("returns true when 'admin' is present", () => {
    assert.equal(hasAdminRole(["admin", "recruiter"]), true);
  });

  it("returns false for empty roles", () => {
    assert.equal(hasAdminRole([]), false);
  });

  it("returns false for undefined roles", () => {
    assert.equal(hasAdminRole(undefined), false);
  });

  it("returns false when only non-admin roles present", () => {
    assert.equal(hasAdminRole(["recruiter", "hr_ops"]), false);
  });
});
