import { describe, expect, it } from "vitest";
import {
  STARTER_PACKS,
  TENANT_CONFIG_FORMAT,
  TENANT_CONFIG_SCHEMA_VERSION,
  TENANT_SETTINGS_BLOCKS,
  configDiffIsEmpty,
  configFingerprint,
  diffTenantConfig,
  getStarterPack,
  isJsonSubset,
  parseTenantConfigDocument,
  resolveTenantDefaultCountry,
  resolveTenantSetupState,
  settingsBlockDef,
  starterPackSourceFromExport,
  tenantConfigSectionsSchema,
  PLATFORM_MODULE_KEYS,
} from "../src";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing");
  return v;
}

describe("C1-F11 starter packs", () => {
  it("every pack is valid configuration and every settings block survives its resolver", () => {
    for (const pack of STARTER_PACKS) {
      expect(tenantConfigSectionsSchema.safeParse(pack.config).success).toBe(true);
      expect(pack.version).toBeGreaterThanOrEqual(1);
      for (const k of Object.keys(pack.modules)) expect(PLATFORM_MODULE_KEYS).toContain(k);
      for (const [key, block] of Object.entries(pack.config.settings ?? {})) {
        const def = settingsBlockDef(key);
        expect(def, key).toBeDefined();
        expect(isJsonSubset(block, must(def).normalize(block)), key).toBe(true);
      }
    }
  });

  it("india pack: IN09–IN18 ranked, ten functions, six IST locations, five-criterion scorecard", () => {
    const p = must(getStarterPack("india-gcc-finance-gbs"));
    expect(must(p.config.jobLevels).map((l) => l.key)).toEqual(
      Array.from({ length: 10 }, (_, i) => `IN${String(i + 9).padStart(2, "0")}`),
    );
    expect(must(p.config.jobLevels).map((l) => l.rank)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(p.config.jobFunctions).toHaveLength(10);
    expect(must(p.config.locations).every((l) => l.timezone === "Asia/Kolkata")).toBe(true);
    expect(must(p.config.locations).map((l) => l.name)).toEqual([
      "Hyderabad",
      "Bengaluru",
      "Pune",
      "Mumbai",
      "Chennai",
      "Delhi NCR",
    ]);
    expect(must(must(p.config.scorecardTemplates)[0]).criteria.map((c) => c.label)).toEqual([
      "People",
      "Performance",
      "Results",
      "Functional",
      "Competencies",
    ]);
    // Rounds only reference the pack's scorecard.
    for (const r of must(p.config.interviewRounds))
      expect(r.scorecardTemplateKey).toBe("gcc_competencies");
    // Phone dedup country (C1-BUGS BUG-5 has no platform default) — a known code.
    expect(p.config.locale?.defaultCountry).toBe("IN");
    expect(resolveTenantDefaultCountry({ defaultCountry: p.config.locale?.defaultCountry })).toBe(
      "IN",
    );
    // Document types: only codes the platform catalogue lacks (a tenant row
    // with a platform code would replace that type for the tenant).
    expect(must(p.config.documentTypes).map((d) => d.code)).toEqual(["uan"]);
    // No client names in a platform pack.
    expect(JSON.stringify(p).toLowerCase()).not.toMatch(/solenis|kyndryl|novachem/);
  });

  it("blank pack lays down nothing", () => {
    expect(must(getStarterPack("blank")).config).toEqual({});
  });
});

describe("C1-F11 config document", () => {
  const doc = (sections: object, extra: object = {}) => ({
    format: TENANT_CONFIG_FORMAT,
    schemaVersion: TENANT_CONFIG_SCHEMA_VERSION,
    exportedAt: "2026-11-11T00:00:00.000Z",
    sections,
    ...extra,
  });

  it("refuses other formats and other schema versions", () => {
    expect(parseTenantConfigDocument({}).ok).toBe(false);
    const v = parseTenantConfigDocument(doc({}, { schemaVersion: 2 }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/version 2 is not compatible/);
    expect(parseTenantConfigDocument(doc({ jobLevels: [{ key: "bad key" }] })).ok).toBe(false);
    expect(parseTenantConfigDocument(doc({ jobLevels: [] })).ok).toBe(true);
  });

  it("diffs adds / changes / removals; absent sections are untouched; additive mode adds only", () => {
    const lvl = (key: string, label = key, isActive = true) => ({ key, label, rank: 1, isActive });
    const current = {
      jobLevels: [lvl("A"), lvl("B"), lvl("C", "C", false)],
      lookups: [
        {
          kind: "asset_type",
          key: "laptop",
          label: "Laptop",
          sortOrder: 1,
          isActive: true,
          attrs: {},
        },
      ],
    };
    const incoming = { jobLevels: [lvl("A", "A2"), lvl("D")] };
    const d = diffTenantConfig(current, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      section: "jobLevels",
      adds: ["D"],
      changes: ["A"],
      removals: ["B"],
    });
    const add = diffTenantConfig(current, incoming, "additive");
    expect(add[0]).toMatchObject({ adds: ["D"], changes: [], removals: [] });
    expect(configDiffIsEmpty(diffTenantConfig(current, { jobLevels: current.jobLevels }))).toBe(
      true,
    );
  });

  it("settings diff ignores non-allowlisted blocks and warns about out-of-range values", () => {
    const d = diffTenantConfig(
      {
        settings: {
          urgency: {
            version: 1,
            weights: { sla: 40, daysInStage: 35, notice: 25 },
            noticeBands: [0, 15, 30, 60, 90],
          },
        },
      },
      {
        settings: {
          ai_provider: { x: 1 },
          urgency: {
            version: 1,
            weights: { sla: 90, daysInStage: 35, notice: 25 },
            noticeBands: [0, 15, 30, 60, 90],
          },
        },
      },
    );
    expect(must(d[0]).changes).toEqual(["urgency"]);
    expect(must(d[0]).warnings.join(" ")).toMatch(/ai_provider: not a configurable settings block/);
    expect(must(d[0]).warnings.join(" ")).toMatch(/urgency: some values are outside/);
  });

  it("people data is scrubbed from settings blocks and restored from the target", () => {
    const sys = must(settingsBlockDef("systemSetup"));
    const scrubbed = must(sys.scrub)({
      version: 1,
      emailAlerts: { enabled: true, recipients: ["a@x.test"], alertTypes: [] },
      escalationRules: [{ daysThreshold: 2, recipient: "b@x.test", severity: "low" }],
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/@x\.test/);
    const restored = must(sys.restore)(scrubbed, {
      emailAlerts: { recipients: ["mine@y.test"] },
      escalationRules: [],
    });
    expect((restored.emailAlerts as { recipients: string[] }).recipients).toEqual(["mine@y.test"]);
    expect(TENANT_SETTINGS_BLOCKS.map((b) => b.key)).not.toContain("starterPack");
    expect(TENANT_SETTINGS_BLOCKS.map((b) => b.key)).not.toContain("setup");
  });

  it("fingerprint is stable under key order and changes with content", () => {
    const a = doc({ jobLevels: [] });
    const b = {
      sections: { jobLevels: [] },
      exportedAt: a.exportedAt,
      schemaVersion: 1,
      format: a.format,
    };
    expect(configFingerprint(a)).toBe(configFingerprint(b));
    expect(configFingerprint(a)).not.toBe(configFingerprint(doc({ jobLevels: [], lookups: [] })));
  });

  it("export → pack skeleton drops organisation-specific sections", () => {
    const parsed = parseTenantConfigDocument(
      doc({
        jobLevels: [{ key: "L1", label: "L1", rank: 1, isActive: true }],
        businessUnits: [
          { slug: "x", name: "X", parent: null, legalEntity: null, isArchived: false },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const src = starterPackSourceFromExport(parsed.document, { key: "my-pack", label: "My pack" });
    expect(src).toMatch(/export const MY_PACK_STARTER_PACK: StarterPack/);
    expect(src).toMatch(/"L1"/);
    expect(src).not.toMatch(/businessUnits/);
    expect(() =>
      starterPackSourceFromExport(parsed.document, { key: "Bad Key", label: "x" }),
    ).toThrow();
  });

  it("setup state resolver never throws", () => {
    expect(resolveTenantSetupState("garbage")).toEqual({
      completedSteps: [],
      approvalRoutingSkipped: false,
      completedAt: null,
    });
    expect(
      resolveTenantSetupState({ completedSteps: ["organisation", "organisation"] }).completedSteps,
    ).toEqual(["organisation"]);
  });
});
