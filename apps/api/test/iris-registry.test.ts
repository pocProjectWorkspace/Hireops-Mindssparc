/**
 * IRIS-A1 — action-registry contract (pure, no DB).
 *
 * HONESTY focus. The registry is the whitelist that bounds what the
 * user-invoked assistant can ever do: irisExecute can only dispatch through it.
 * These are the pure guarantees that make that bound real —
 *   - the one wired action (create_requisition_jd) is registered and reachable
 *     by id, and NOTHING else is;
 *   - its input contract genuinely rejects an empty / malformed payload (so a
 *     "confirm" can't commit a junk requisition);
 *   - its preview is non-empty (the client has something to show pre-confirm);
 *   - the serialisable menu is exactly the registry, projected to the wire
 *     shape, and JSON-round-trips (no server code leaks into the menu).
 *
 * Kept DB-free so the whitelist contract is covered without live-DB flake; the
 * end-to-end honesty (real gated write + persisted+read-back provenance) is the
 * iris-a1 integration test.
 */

import { describe, it, expect } from "vitest";
import { IRIS_ACTIONS, getIrisAction, listIrisActions } from "../src/lib/iris/registry";
import { createRequisitionJdAction } from "../src/lib/iris/actions/create-requisition-jd";
import { advanceApplicationAction } from "../src/lib/iris/actions/advance-application";
import { rejectApplicationAction } from "../src/lib/iris/actions/reject-application";
import { openOnboardingCaseAction } from "../src/lib/iris/actions/open-onboarding-case";

describe("IRIS-A1 action registry", () => {
  it("registers create_requisition_jd and exposes it by id", () => {
    const action = getIrisAction("create_requisition_jd");
    expect(action).toBeDefined();
    expect(action!.id).toBe("create_requisition_jd");
    expect(IRIS_ACTIONS.create_requisition_jd).toBeDefined();
    // The registered entry mirrors the concrete action's descriptor.
    expect(action!.label).toBe(createRequisitionJdAction.label);
    expect(action!.group).toBe(createRequisitionJdAction.group);
    expect(action!.destructive).toBe(createRequisitionJdAction.destructive);
    expect(action!.bulk).toBe(createRequisitionJdAction.bulk);
    // Every registry key equals its action's own id (no id/key drift).
    for (const [key, entry] of Object.entries(IRIS_ACTIONS)) {
      expect(entry.id).toBe(key);
    }
  });

  it("returns undefined for an unknown / non-whitelisted action id", () => {
    expect(getIrisAction("drop_all_requisitions")).toBeUndefined();
    expect(getIrisAction("")).toBeUndefined();
    expect(getIrisAction("createRequisitionDraft")).toBeUndefined();
  });

  it("create_requisition_jd inputSchema rejects empty / invalid payloads", () => {
    const schema = createRequisitionJdAction.inputSchema;
    // Empty object — title + locationType are the required minimum.
    expect(schema.safeParse({}).success).toBe(false);
    // Missing locationType.
    expect(schema.safeParse({ title: "Staff Engineer" }).success).toBe(false);
    // Missing title.
    expect(schema.safeParse({ locationType: "hybrid" }).success).toBe(false);
    // Title too short (min 2) — a malformed value can't slip through.
    expect(schema.safeParse({ title: "x", locationType: "hybrid" }).success).toBe(false);
    // Bogus locationType.
    expect(schema.safeParse({ title: "Staff Engineer", locationType: "moon" }).success).toBe(false);
    // A valid minimum parses.
    expect(schema.safeParse({ title: "Staff Engineer", locationType: "hybrid" }).success).toBe(
      true,
    );
  });

  it("the registered (erased) entry's parse enforces the same contract irisExecute runs", () => {
    // irisExecute validates via getIrisAction(id).parse(rawParams) — the erased
    // boundary must reject junk and accept a valid minimum, exactly like the
    // concrete inputSchema.
    const entry = getIrisAction("create_requisition_jd")!;
    expect(() => entry.parse({})).toThrow();
    expect(() => entry.parse({ title: "x", locationType: "hybrid" })).toThrow();
    const parsed = entry.parse({ title: "Staff Engineer", locationType: "hybrid" }) as {
      title: string;
    };
    expect(parsed.title).toBe("Staff Engineer");
  });

  it("buildPreview returns a non-empty summary + details", () => {
    const preview = createRequisitionJdAction.buildPreview({
      title: "Staff Engineer",
      locationType: "hybrid",
      primaryLocation: "Bengaluru",
      seniority: "Senior",
      numberOfOpenings: 2,
    });
    expect(preview.summary.length).toBeGreaterThan(0);
    expect(preview.summary).toContain("Staff Engineer");
    expect(Array.isArray(preview.details)).toBe(true);
    expect(preview.details.length).toBeGreaterThan(0);
    for (const line of preview.details) {
      expect(typeof line).toBe("string");
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("listIrisActions() is the whitelist, serialisable, and shape-exact", () => {
    const menu = listIrisActions();
    // Whitelist-only: exactly the registry, same ids.
    expect(menu.map((m) => m.id).sort()).toEqual(Object.keys(IRIS_ACTIONS).sort());
    // Every entry carries EXACTLY the wire fields — no zod / server code leaks.
    // IRIS-B1.1 adds `roles` (the per-action app-surface role set) to the menu.
    for (const entry of menu) {
      expect(Object.keys(entry).sort()).toEqual(
        ["bulk", "destructive", "group", "id", "label", "roles"].sort(),
      );
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.group).toBe("string");
      expect(typeof entry.destructive).toBe("boolean");
      expect(typeof entry.bulk).toBe("boolean");
      expect(Array.isArray(entry.roles)).toBe(true);
      expect(entry.roles.length).toBeGreaterThan(0);
      for (const role of entry.roles) expect(typeof role).toBe("string");
    }
    // JSON round-trips byte-for-byte (genuinely serialisable).
    expect(JSON.parse(JSON.stringify(menu))).toEqual(menu);
  });
});

describe("IRIS-B1 pipeline / onboarding actions", () => {
  const B1_ACTIONS = [advanceApplicationAction, rejectApplicationAction, openOnboardingCaseAction];

  it("registers advance_application, reject_application, open_onboarding_case (whitelist-only)", () => {
    for (const action of B1_ACTIONS) {
      const entry = getIrisAction(action.id);
      expect(entry, `${action.id} is registered`).toBeDefined();
      expect(entry!.id).toBe(action.id);
      expect(entry!.label).toBe(action.label);
      expect(entry!.group).toBe(action.group);
      expect(entry!.destructive).toBe(action.destructive);
      expect(IRIS_ACTIONS[action.id]).toBeDefined();
    }
    // The one requisition action is untouched; the whitelist is exactly these four.
    expect(Object.keys(IRIS_ACTIONS).sort()).toEqual(
      [
        "advance_application",
        "create_requisition_jd",
        "open_onboarding_case",
        "reject_application",
      ].sort(),
    );
  });

  it("each action carries its expected per-action roles (IRIS-B1.1)", () => {
    // The roles mirror the app-surface roles a human needs to run each action.
    // admin is the super-role present in every action's set.
    expect(createRequisitionJdAction.roles.sort()).toEqual(["admin", "hiring_manager"].sort());
    expect(advanceApplicationAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    expect(rejectApplicationAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    expect(openOnboardingCaseAction.roles.sort()).toEqual(
      ["admin", "recruiter", "hr_ops", "people_ops"].sort(),
    );
    // The erased registry entries carry the SAME roles the concrete actions do.
    for (const action of [createRequisitionJdAction, ...B1_ACTIONS]) {
      expect(getIrisAction(action.id)!.roles).toEqual(action.roles);
    }
    // admin is in every action's role set (sees + can run everything).
    for (const entry of listIrisActions()) {
      expect(entry.roles).toContain("admin");
    }
  });

  it("groups + destructive flags: reject is destructive, advance / onboarding are not", () => {
    expect(advanceApplicationAction.group).toBe("Pipeline");
    expect(advanceApplicationAction.destructive).toBe(false);
    expect(rejectApplicationAction.group).toBe("Pipeline");
    // The one destructive action in this ticket — the drawer shows destructive framing.
    expect(rejectApplicationAction.destructive).toBe(true);
    expect(openOnboardingCaseAction.group).toBe("Onboarding");
    expect(openOnboardingCaseAction.destructive).toBe(false);
  });

  it("inputSchemas reject invalid payloads and accept the real minimum", () => {
    // advance_application — needs a uuid applicationId + a valid stage.
    expect(advanceApplicationAction.inputSchema.safeParse({}).success).toBe(false);
    expect(
      advanceApplicationAction.inputSchema.safeParse({ applicationId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      advanceApplicationAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
        targetStage: "moon",
      }).success,
    ).toBe(false);
    expect(
      advanceApplicationAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
        targetStage: "shortlisted",
      }).success,
    ).toBe(true);

    // reject_application — needs a uuid applicationId (reason optional at the
    // schema; the drawer requires it client-side).
    expect(rejectApplicationAction.inputSchema.safeParse({}).success).toBe(false);
    expect(rejectApplicationAction.inputSchema.safeParse({ applicationId: "nope" }).success).toBe(
      false,
    );
    expect(
      rejectApplicationAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
        reason: "Not a fit for the role",
      }).success,
    ).toBe(true);

    // open_onboarding_case — applicationId only.
    expect(openOnboardingCaseAction.inputSchema.safeParse({}).success).toBe(false);
    expect(
      openOnboardingCaseAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("buildPreview returns a non-empty summary for each action, naming the reason on reject", () => {
    const advance = advanceApplicationAction.buildPreview({
      applicationId: "11111111-1111-4111-8111-111111111111",
      targetStage: "tech_interview",
    });
    expect(advance.summary.length).toBeGreaterThan(0);
    expect(advance.summary.toLowerCase()).toContain("tech interview");

    const reject = rejectApplicationAction.buildPreview({
      applicationId: "11111111-1111-4111-8111-111111111111",
      reason: "Salary expectations too high",
    });
    expect(reject.summary.length).toBeGreaterThan(0);
    // The preview names the reason so the destructive review card shows it.
    expect(reject.details.join(" ")).toContain("Salary expectations too high");

    const onboarding = openOnboardingCaseAction.buildPreview({
      applicationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(onboarding.summary.length).toBeGreaterThan(0);
  });

  it("the erased entries enforce the same input contract irisExecute runs", () => {
    for (const action of B1_ACTIONS) {
      const entry = getIrisAction(action.id)!;
      expect(() => entry.parse({})).toThrow();
    }
    const advanceParsed = getIrisAction("advance_application")!.parse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      targetStage: "shortlisted",
    }) as { targetStage: string };
    expect(advanceParsed.targetStage).toBe("shortlisted");
  });
});
