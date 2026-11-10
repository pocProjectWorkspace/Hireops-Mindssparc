import { describe, expect, it } from "vitest";
import {
  DIVERSE_SLATE_VIEW_ROLES,
  DIVERSITY_PREFER_NOT_TO_SAY,
  DIVERSITY_SELF_ID_DISCLOSURE,
  DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
  canViewDiverseSlate,
  computeDiverseSlateStatus,
  defaultDiversitySlateSettings,
  diverseSlateLabel,
  diversitySlateSettingsSchema,
  normaliseDiversitySelfIdSubmission,
  qualifyingSelfIdPairs,
  resolveDiversitySlateSettings,
  toDiversityCaptureConfig,
} from "../src/diversity-slate";
import {
  getCandidateByIdOutputSchema,
  listCandidatesOutputSchema,
  listCandidatesByRequisitionOutputSchema,
  candidateGetProfileOutputSchema,
} from "../src/procedures";

/**
 * PC-26 — diverse-slate contracts. Pure: no DB. The DB-backed count, role
 * gate and RLS checks live in apps/api/test/pc26-diversity-slate.test.ts
 * (needs migration 0126).
 */

describe("diversitySlate settings block", () => {
  it("defaults to DISABLED with the platform categories / stages / min 2", () => {
    const d = defaultDiversitySlateSettings();
    expect(d.enabled).toBe(false);
    expect(d.defaultMin).toBe(2);
    expect(d.countedStages).toEqual(["shortlisted", "tech_interview", "hr_round", "offer_drafted"]);
    expect(qualifyingSelfIdPairs({ ...d, enabled: true }).sort()).toEqual(
      ["gender:non_binary", "gender:self_described", "gender:woman"].sort(),
    );
  });

  it("resolver never throws and falls back to the disabled default on junk", () => {
    for (const junk of [undefined, null, 42, "x", { enabled: "yes" }, { categories: [] }]) {
      const r = resolveDiversitySlateSettings(junk);
      expect(r.enabled).toBe(false);
    }
    const partial = resolveDiversitySlateSettings({ enabled: true, defaultMin: 3 });
    expect(partial.enabled).toBe(true);
    expect(partial.defaultMin).toBe(3);
    expect(partial.categories.length).toBe(1);
  });

  it("rejects the prefer-not-to-say sentinel as a stored option value and duplicate keys", () => {
    const base = defaultDiversitySlateSettings();
    expect(
      diversitySlateSettingsSchema.safeParse({
        ...base,
        categories: [
          {
            key: "gender",
            label: "Gender",
            options: [{ value: DIVERSITY_PREFER_NOT_TO_SAY, label: "x", countsAsDiverse: true }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      diversitySlateSettingsSchema.safeParse({
        ...base,
        categories: [base.categories[0], base.categories[0]],
      }).success,
    ).toBe(false);
  });

  it("qualifying pairs follow the tenant's categories, not code", () => {
    const s = resolveDiversitySlateSettings({
      enabled: true,
      categories: [
        {
          key: "veteran",
          label: "Veteran status",
          options: [
            { value: "veteran", label: "Veteran", countsAsDiverse: true },
            { value: "not_veteran", label: "Not a veteran", countsAsDiverse: false },
          ],
        },
      ],
    });
    expect(qualifyingSelfIdPairs(s)).toEqual(["veteran:veteran"]);
  });
});

describe("computeDiverseSlateStatus", () => {
  const base = { tenantEnabled: true, required: true, roleMin: null, tenantDefaultMin: 2 };
  it("not_required when the tenant is off or the role doesn't require it — no numbers", () => {
    expect(
      computeDiverseSlateStatus({ ...base, tenantEnabled: false, qualifyingCount: 5 }),
    ).toEqual({ status: "not_required", requiredMin: null, diverseInSlate: null });
    expect(computeDiverseSlateStatus({ ...base, required: false, qualifyingCount: 5 })).toEqual({
      status: "not_required",
      requiredMin: null,
      diverseInSlate: null,
    });
  });
  it("short / met against the tenant default or the role's own minimum", () => {
    expect(computeDiverseSlateStatus({ ...base, qualifyingCount: 1 })).toEqual({
      status: "short",
      requiredMin: 2,
      diverseInSlate: 1,
    });
    expect(computeDiverseSlateStatus({ ...base, qualifyingCount: 2 }).status).toBe("met");
    expect(computeDiverseSlateStatus({ ...base, roleMin: 3, qualifyingCount: 2 }).status).toBe(
      "short",
    );
  });
  it("label copy", () => {
    expect(diverseSlateLabel({ status: "short", requiredMin: 2, diverseInSlate: 1 })).toBe(
      "Diverse slate: 1/2 — short",
    );
    expect(
      diverseSlateLabel({ status: "not_required", requiredMin: null, diverseInSlate: null }),
    ).toBeNull();
  });
});

describe("candidate submission normalisation", () => {
  const s = resolveDiversitySlateSettings({ enabled: true });
  it("prefer-not-to-say → null (withdraw); unknown categories / values are dropped", () => {
    const m = normaliseDiversitySelfIdSubmission(
      {
        disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
        answers: [
          { categoryKey: "gender", value: DIVERSITY_PREFER_NOT_TO_SAY },
          { categoryKey: "ethnicity", value: "anything" },
        ],
      },
      s,
    );
    expect([...m.entries()]).toEqual([["gender", null]]);
    const m2 = normaliseDiversitySelfIdSubmission(
      {
        disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
        answers: [{ categoryKey: "gender", value: "not_an_option" }],
      },
      s,
    );
    expect(m2.size).toBe(0);
  });
});

describe("guardrails", () => {
  it("count visibility is exactly admin / hr_head / recruiter", () => {
    expect([...DIVERSE_SLATE_VIEW_ROLES].sort()).toEqual(["admin", "hr_head", "recruiter"]);
    expect(canViewDiverseSlate(["hiring_manager"])).toBe(false);
    expect(canViewDiverseSlate(["panel_member"])).toBe(false);
    expect(canViewDiverseSlate(["recruiter"])).toBe(true);
  });

  it("disclosure states the purpose, voluntariness and withdrawal; version is stamped", () => {
    const body = DIVERSITY_SELF_ID_DISCLOSURE.body.join(" ");
    expect(body).toContain("never used to screen or score you");
    expect(body).toContain("optional");
    expect(body).toContain("withdraw");
    expect(DIVERSITY_SELF_ID_DISCLOSURE.version).toBe(DIVERSITY_SELF_ID_DISCLOSURE_VERSION);
  });

  it("candidate capture config never says which answers count", () => {
    const cfg = toDiversityCaptureConfig(resolveDiversitySlateSettings({ enabled: true }), "Acme");
    expect(JSON.stringify(cfg)).not.toContain("countsAsDiverse");
    expect(cfg.body.join(" ")).toContain("Acme");
    const off = toDiversityCaptureConfig(defaultDiversitySlateSettings(), "Acme");
    expect(off.enabled).toBe(false);
    expect(off.categories).toEqual([]);
  });

  /** Walks a zod schema and collects every object key at any depth. */
  function collectKeys(schema: unknown, out = new Set<string>(), seen = new Set<unknown>()) {
    if (!schema || typeof schema !== "object" || seen.has(schema)) return out;
    seen.add(schema);
    const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return out;
    const shape = def["shape"] as Record<string, unknown> | undefined;
    if (shape) {
      for (const [k, v] of Object.entries(shape)) {
        out.add(k);
        collectKeys(v, out, seen);
      }
    }
    for (const key of ["element", "innerType", "in", "out", "schema", "left", "right"]) {
      if (def[key]) collectKeys(def[key], out, seen);
    }
    for (const key of ["options", "items"]) {
      const arr = def[key];
      if (Array.isArray(arr)) for (const x of arr) collectKeys(x, out, seen);
    }
    return out;
  }

  it("candidate detail / list / by-role / profile output schemas carry no self-ID field", () => {
    for (const schema of [
      getCandidateByIdOutputSchema,
      listCandidatesOutputSchema,
      listCandidatesByRequisitionOutputSchema,
      candidateGetProfileOutputSchema,
    ]) {
      const keys = [...collectKeys(schema)];
      expect(keys.length).toBeGreaterThan(3); // the walker actually walked
      const leaks = keys.filter((k) => /divers|selfid|self_id|gender|demograph|ethnic/i.test(k));
      expect(leaks).toEqual([]);
    }
  });
});
