/**
 * PC-23 — role DISPLAY labels. Pure: the resolver, the override diff and the
 * single `roleLabel` helper every surface uses. Keys / permissions are never
 * touched — asserted by checking the key list mirrors INTERNAL_TENANT_ROLES.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_LABELS,
  INTERNAL_TENANT_ROLES,
  ROLE_LABEL_KEYS,
  roleLabel,
  roleLabelOverridesOf,
  roleLabelsSchema,
  resolveRoleLabels,
  updateRoleLabelsInputSchema,
} from "@hireops/api-types";

describe("PC-23 role labels", () => {
  it("covers exactly the internal roles (no new keys, none missing)", () => {
    expect([...ROLE_LABEL_KEYS].sort()).toEqual([...INTERNAL_TENANT_ROLES].sort());
  });

  it("platform default = the labels the portal showed before", () => {
    expect(DEFAULT_ROLE_LABELS).toMatchObject({
      hr_head: "HR Head",
      hr_ops: "HR Ops",
      it_admin: "IT Admin",
      hiring_manager: "Hiring Manager",
    });
    expect(resolveRoleLabels(undefined)).toEqual(DEFAULT_ROLE_LABELS);
  });

  it("tenant override wins per key; everything else falls back", () => {
    const labels = resolveRoleLabels({ hr_head: "  TA Lead ", recruiter: "Talent Partner" });
    expect(labels.hr_head).toBe("TA Lead");
    expect(labels.recruiter).toBe("Talent Partner");
    expect(labels.admin).toBe("Admin");
  });

  it("malformed stored blocks never throw and never blank a label", () => {
    expect(resolveRoleLabels("nope")).toEqual(DEFAULT_ROLE_LABELS);
    expect(resolveRoleLabels([1, 2])).toEqual(DEFAULT_ROLE_LABELS);
    const labels = resolveRoleLabels({
      hr_head: "",
      admin: 42,
      ghost_role: "Ghost",
      recruiter: "x".repeat(41),
    });
    expect(labels).toEqual(DEFAULT_ROLE_LABELS);
    expect((labels as Record<string, string>).ghost_role).toBeUndefined();
  });

  it("roleLabel: override → default → title-cased unknown key → '' for empty", () => {
    const labels = resolveRoleLabels({ hr_head: "TA Lead" });
    expect(roleLabel("hr_head", labels)).toBe("TA Lead");
    expect(roleLabel("hr_head")).toBe("HR Head");
    expect(roleLabel("partner_admin", labels)).toBe("Partner Admin");
    expect(roleLabel("", labels)).toBe("");
    expect(roleLabel(null)).toBe("");
  });

  it("only real differences from the default are stored", () => {
    expect(
      roleLabelOverridesOf({ hr_head: "TA Lead", admin: "Admin", recruiter: "  ", ghost: "x" }),
    ).toEqual({
      hr_head: "TA Lead",
    });
  });

  it("write schema rejects unknown role keys and over-long labels", () => {
    expect(roleLabelsSchema.safeParse({ ghost_role: "X" }).success).toBe(false);
    expect(roleLabelsSchema.safeParse({ hr_head: "x".repeat(41) }).success).toBe(false);
    expect(
      updateRoleLabelsInputSchema.safeParse({ overrides: { hr_head: "TA Lead" } }).success,
    ).toBe(true);
  });
});
