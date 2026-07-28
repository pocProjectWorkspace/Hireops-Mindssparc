import { describe, expect, it } from "vitest";
import type { IrisProvenanceRow } from "@hireops/api-types";
import {
  hasIrisProvenance,
  indexProvenance,
  provenanceTooltip,
} from "../src/components/iris/provenance";

/**
 * IRIS-A2 — the AI-assisted pill is persisted-and-consumed: it must show ONLY
 * for an entity that carries an Iris provenance row, and never for a
 * human-created one. That honesty flip is `hasIrisProvenance`. DB-free.
 */
function row(entityId: string, overrides: Partial<IrisProvenanceRow> = {}): IrisProvenanceRow {
  return {
    entityId,
    assistant: "iris",
    actionId: "create_requisition_jd",
    confirmedByUserId: "00000000-0000-4000-8000-000000000001",
    confirmedByLabel: "Asha",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("hasIrisProvenance (the honesty flip)", () => {
  const irisMade = "11111111-1111-4111-8111-111111111111";
  const humanMade = "22222222-2222-4222-8222-222222222222";
  const rows = [row(irisMade)];

  it("shows the pill for an entity WITH a provenance row", () => {
    expect(hasIrisProvenance(rows, irisMade)).toBe(true);
  });

  it("does NOT show the pill for an entity WITHOUT a provenance row", () => {
    expect(hasIrisProvenance(rows, humanMade)).toBe(false);
  });

  it("does NOT show the pill when there are no rows at all", () => {
    expect(hasIrisProvenance(undefined, irisMade)).toBe(false);
    expect(hasIrisProvenance([], irisMade)).toBe(false);
  });
});

describe("indexProvenance", () => {
  it("keys rows by entityId, first-seen wins", () => {
    const a = row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { actionId: "first" });
    const aDup = row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { actionId: "second" });
    const map = indexProvenance([a, aDup]);
    expect(map.size).toBe(1);
    expect(map.get(a.entityId)?.actionId).toBe("first");
  });
});

describe("provenanceTooltip", () => {
  it("names the confirming human and a relative time", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    const r = row("x", { createdAt: "2026-01-01T00:00:00Z", confirmedByLabel: "Asha" });
    expect(provenanceTooltip(r, now)).toBe("Drafted by Iris · approved by Asha · 10 min ago");
  });

  it("falls back gracefully when no confirmer label is known", () => {
    const now = Date.parse("2026-01-01T00:00:30Z");
    const r = row("x", { createdAt: "2026-01-01T00:00:00Z", confirmedByLabel: null });
    expect(provenanceTooltip(r, now)).toBe("Drafted by Iris · approved by a teammate · just now");
  });
});
