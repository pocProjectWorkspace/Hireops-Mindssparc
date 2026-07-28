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
    for (const entry of menu) {
      expect(Object.keys(entry).sort()).toEqual(
        ["bulk", "destructive", "group", "id", "label"].sort(),
      );
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.group).toBe("string");
      expect(typeof entry.destructive).toBe("boolean");
      expect(typeof entry.bulk).toBe("boolean");
    }
    // JSON round-trips byte-for-byte (genuinely serialisable).
    expect(JSON.parse(JSON.stringify(menu))).toEqual(menu);
  });
});
