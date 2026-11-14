import { z } from "zod";
import {
  resolveAiBudget,
  resolveReportDigests,
  resolveShortlistDefaults,
  resolveSystemSetup,
} from "./admin-ops";
import { resolveAiSettings } from "./ai-settings";
import { resolveBiasLexicon } from "./bias-lexicon";
import { resolveBrandingSettings } from "./branding";
import { resolveBulkCvUploadLimits } from "./bulk-cv-upload";
import { resolveDiversitySlateSettings } from "./diversity-slate";
import {
  resolveFeedbackSharing,
  resolveGovernancePolicy,
  resolveScreeningPrivacy,
} from "./governance";
import { resolveIrisPolicy } from "./iris";
import { resolvePartnerDefaults } from "./partner-defaults";
import { resolvePreJoiningEngagementSettings } from "./pre-joining-engagement";
import { resolveRetentionPolicy } from "./retention-policy";
import { resolveRoleLabels } from "./role-labels";
import { schedulingSettingsSchema } from "./scheduling";
import { resolveScoringWeights } from "./scoring-weights";
import { slaThresholdsSchema } from "./sla-thresholds";
import { resolveTenantLabels } from "./tenant-labels";
import { resolveUrgencySettings } from "./urgency-settings";

/**
 * C1-F11 — tenant CONFIGURATION as a portable, versioned document (Plan A §13,
 * §14.3 step 5, §15 P7).
 *
 * One shape serves three jobs:
 *   1. config EXPORT — a tenant's configuration (never people, candidates,
 *      requisitions or secrets) as JSON;
 *   2. config IMPORT — a dry-run diff per section, then an apply;
 *   3. STARTER PACKS — a pack is a partial document plus pack metadata, and
 *      provisioning applies it through the same applier in additive mode.
 *
 * Section semantics on import: a section PRESENT in the document is the full
 * desired state for that section (adds, changes AND removals); a section
 * ABSENT is left untouched. Removals never hard-delete anything another row
 * can point at: org + job architecture rows are DEACTIVATED, business units /
 * comp bands / panel pools / JD templates ARCHIVED, approval matrices
 * END-DATED. Lists, templates, overrides and policy rows revert to the
 * platform default by deleting the tenant row (which is exactly what the
 * existing per-page "reset" actions do).
 *
 * Every record is keyed by a NATURAL key (slug / key / name / title), never a
 * database id, so a document moves between tenants and stacks.
 *
 * Pure zod + pure functions: no I/O.
 */

export const TENANT_CONFIG_FORMAT = "hireops.tenant-config" as const;
/** Bump on a BREAKING change to the document shape; imports refuse any other version. */
export const TENANT_CONFIG_SCHEMA_VERSION = 1 as const;

// ─────────────────────────── settings blocks ───────────────────────────

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One exportable `tenants.settings` block. `normalize` is the block's own
 * never-throwing resolver (used to check an incoming block is understood).
 * `scrub` removes people data before export; `restore` puts the TARGET's
 * people data back on import, so importing never wipes the target's
 * recipients and never copies the source's.
 */
export interface TenantSettingsBlockDef {
  key: string;
  label: string;
  normalize: (raw: unknown) => unknown;
  scrub?: (block: Json) => Json;
  restore?: (incoming: Json, existing: Json | undefined) => Json;
}

function withRecipients(block: Json, recipients: unknown): Json {
  return { ...block, recipients: Array.isArray(recipients) ? recipients : [] };
}

/**
 * The allowlist of exportable settings blocks. Anything not listed here — the
 * starter-pack marker, the setup-wizard state, provider switches, any future
 * or unknown key — is never exported and never written by an import.
 */
export const TENANT_SETTINGS_BLOCKS: readonly TenantSettingsBlockDef[] = [
  {
    key: "systemSetup",
    label: "System setup (alerts, escalation, landing pages)",
    normalize: resolveSystemSetup,
    // Alert recipients + escalation recipients are named mailboxes → people data.
    scrub: (b) => ({
      ...b,
      emailAlerts: { ...(isRecord(b.emailAlerts) ? b.emailAlerts : {}), recipients: [] },
      escalationRules: [],
    }),
    restore: (incoming, existing) => ({
      ...incoming,
      emailAlerts: {
        ...(isRecord(incoming.emailAlerts) ? incoming.emailAlerts : {}),
        recipients:
          existing &&
          isRecord(existing.emailAlerts) &&
          Array.isArray(existing.emailAlerts.recipients)
            ? existing.emailAlerts.recipients
            : [],
      },
      escalationRules:
        existing && Array.isArray(existing.escalationRules) ? existing.escalationRules : [],
    }),
  },
  { key: "shortlistDefaults", label: "Shortlist defaults", normalize: resolveShortlistDefaults },
  { key: "aiBudget", label: "AI budget", normalize: resolveAiBudget },
  {
    key: "reportDigests",
    label: "Report digests",
    normalize: resolveReportDigests,
    scrub: (b) => withRecipients(b, []),
    restore: (incoming, existing) => withRecipients(incoming, existing?.recipients),
  },
  { key: "roleLabels", label: "Role labels", normalize: resolveRoleLabels },
  {
    key: "slaThresholds",
    label: "SLA thresholds",
    normalize: (raw) => {
      const p = slaThresholdsSchema.safeParse(raw ?? {});
      return p.success ? p.data : {};
    },
  },
  { key: "governancePolicy", label: "Governance policy", normalize: resolveGovernancePolicy },
  { key: "retentionPolicy", label: "Retention policy", normalize: resolveRetentionPolicy },
  {
    key: "preJoiningEngagement",
    label: "Pre-joining engagement",
    normalize: resolvePreJoiningEngagementSettings,
  },
  { key: "aiSettings", label: "AI settings", normalize: resolveAiSettings },
  { key: "labels", label: "Display labels", normalize: resolveTenantLabels },
  { key: "urgency", label: "Urgency", normalize: resolveUrgencySettings },
  { key: "irisPolicy", label: "Iris assistant policy", normalize: resolveIrisPolicy },
  { key: "biasLexicon", label: "Bias lexicon", normalize: resolveBiasLexicon },
  { key: "scoringWeights", label: "Scoring weights", normalize: resolveScoringWeights },
  { key: "diversitySlate", label: "Diverse slate", normalize: resolveDiversitySlateSettings },
  { key: "screeningPrivacy", label: "Screening privacy", normalize: resolveScreeningPrivacy },
  { key: "feedbackSharing", label: "Feedback sharing", normalize: resolveFeedbackSharing },
  { key: "partnerDefaults", label: "Partner defaults", normalize: resolvePartnerDefaults },
  {
    key: "scheduling",
    label: "Interview scheduling",
    normalize: (raw) => {
      const p = schedulingSettingsSchema.safeParse(raw ?? {});
      return p.success ? p.data : {};
    },
  },
  { key: "branding", label: "Branding", normalize: resolveBrandingSettings },
  { key: "bulkCvUpload", label: "Bulk CV upload limits", normalize: resolveBulkCvUploadLimits },
  {
    key: "communications",
    label: "Communications (sender display name)",
    normalize: (raw) => resolveCommunicationsSettings(raw),
  },
];

export const TENANT_SETTINGS_BLOCK_KEYS = TENANT_SETTINGS_BLOCKS.map((b) => b.key);

export function settingsBlockDef(key: string): TenantSettingsBlockDef | undefined {
  return TENANT_SETTINGS_BLOCKS.find((b) => b.key === key);
}

/**
 * True when every value in `a` is present, equal, in `b` (arrays must match
 * length and element-wise). Used to check an incoming block survives its own
 * resolver: a valid (possibly partial) block is a subset of its resolved form.
 */
export function isJsonSubset(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => isJsonSubset(x, b[i]));
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    return Object.entries(a).every(([k, v]) => isJsonSubset(v, b[k]));
  }
  return a === b;
}

// ─────────────────────────── communications block ───────────────────────────

/**
 * `tenants.settings.communications` — the sender DISPLAY NAME on tenant email
 * (the address itself stays the deployment's EMAIL_FROM; moving the address
 * into tenant config is deferred). null = the platform default display name.
 */
export const communicationsSettingsSchema = z.object({
  senderName: z.string().trim().min(1).max(80).nullable().default(null),
});
export type CommunicationsSettings = z.infer<typeof communicationsSettingsSchema>;

export function resolveCommunicationsSettings(raw: unknown): CommunicationsSettings {
  const p = communicationsSettingsSchema.safeParse(raw ?? {});
  return p.success ? p.data : { senderName: null };
}

// ─────────────────────────── sections ───────────────────────────

const shortText = (max: number) => z.string().max(max);
const archKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/);
const lookupKey = z.string().regex(/^[a-z0-9][a-z0-9_]{0,39}$/);
const lookupKind = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const iso2 = z.string().regex(/^[A-Z]{2}$/);
const snake = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const configLocaleSchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  timezone: shortText(64).nullable(),
  locale: shortText(20).nullable(),
  /**
   * `tenants.settings.defaultCountry` (ISO-3166 alpha-2) — the country a bare
   * national phone number is placed in for person dedup (C1-BUGS BUG-5).
   * Optional so documents exported before it existed still parse.
   */
  defaultCountry: iso2.nullable().optional(),
});
export type ConfigLocale = z.infer<typeof configLocaleSchema>;

/**
 * The locale section's fields — each a top-level `tenants.settings` scalar
 * (not a settings block, so they travel here rather than in `settings`).
 */
export const TENANT_CONFIG_LOCALE_FIELDS = [
  "currency",
  "timezone",
  "locale",
  "defaultCountry",
] as const;

export const configLookupSchema = z.object({
  kind: lookupKind,
  key: lookupKey,
  label: z.string().min(1).max(80),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ConfigLookup = z.infer<typeof configLookupSchema>;

export const configLegalEntitySchema = z.object({
  name: z.string().min(1).max(160),
  countryCode: iso2,
  isActive: z.boolean(),
});
export type ConfigLegalEntity = z.infer<typeof configLegalEntitySchema>;

export const configLocationSchema = z.object({
  name: z.string().min(1).max(160),
  city: shortText(120).nullable(),
  region: shortText(120).nullable(),
  countryCode: iso2,
  /** The legal entity, by name. */
  legalEntity: z.string().min(1).max(160).nullable(),
  timezone: z.string().min(1).max(64).nullable(),
  isActive: z.boolean(),
});
export type ConfigLocation = z.infer<typeof configLocationSchema>;

export const configBusinessUnitSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1)
    .max(80),
  name: z.string().min(1).max(160),
  /** The parent business unit, by slug. */
  parent: z.string().nullable(),
  legalEntity: z.string().nullable(),
  isArchived: z.boolean(),
});
export type ConfigBusinessUnit = z.infer<typeof configBusinessUnitSchema>;

export const configJobFunctionSchema = z.object({
  key: archKey,
  label: z.string().min(1).max(120),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type ConfigJobFunction = z.infer<typeof configJobFunctionSchema>;

export const configJobLevelSchema = z.object({
  key: archKey,
  label: z.string().min(1).max(120),
  rank: z.number().int().min(0).max(10000),
  isActive: z.boolean(),
});
export type ConfigJobLevel = z.infer<typeof configJobLevelSchema>;

export const configJobProfileSchema = z.object({
  title: z.string().min(2).max(200),
  /** Function / level references are by KEY; the JD template by title. */
  jobFunction: archKey.nullable(),
  levelMin: archKey.nullable(),
  levelMax: archKey.nullable(),
  defaultJdTemplate: z.string().nullable(),
  competencies: z.array(z.object({ key: z.string(), label: z.string() })),
  canonicalMarketTitle: z.string().nullable(),
  isActive: z.boolean(),
});
export type ConfigJobProfile = z.infer<typeof configJobProfileSchema>;

export const configCompBandSchema = z.object({
  name: z.string().min(1).max(160),
  level: z.string().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Major units as strings (numeric(12,2) round-trips exactly). */
  minMajor: z.string(),
  maxMajor: z.string(),
  midpointMajor: z.string().nullable(),
  jobLevel: archKey.nullable(),
  jobFunction: archKey.nullable(),
  location: z.string().nullable(),
  isArchived: z.boolean(),
});
export type ConfigCompBand = z.infer<typeof configCompBandSchema>;

export const configInterviewRoundSchema = z.object({
  /**
   * C2-F12: the named loop the round belongs to. Omitted = the 'default' loop
   * (every document exported before named loops existed), so old files parse
   * and diff exactly as before.
   */
  loopKey: snake.optional(),
  roundNumber: z.number().int().min(1).max(20),
  roundName: z.string().min(1).max(120),
  durationMinutes: z.number().int().min(15).max(480),
  mode: z.enum(["video", "onsite", "phone"]),
  /** C2-F12: null = no pinned scorecard (resolved by applicability). */
  scorecardTemplateKey: snake.nullable(),
  competencyFocus: z.array(z.string().min(1).max(80)).max(20),
});
export type ConfigInterviewRound = z.infer<typeof configInterviewRoundSchema>;

/** C2-F12 — a named interview loop (the 'default' loop always exists). */
export const configInterviewLoopSchema = z.object({
  loopKey: snake,
  label: z.string().min(1).max(120),
  isActive: z.boolean(),
});
export type ConfigInterviewLoop = z.infer<typeof configInterviewLoopSchema>;

/**
 * C2-F12 — an applicability rule. The target template and every condition
 * value travel by NATURAL key so the rule moves between tenants: the target
 * is a loop key (interview_loop) or a scorecard key (scorecard); conditions
 * name legal entities / locations by name, business units by slug, functions
 * and levels by key, job profiles by title. Level ranks, countries and lookup
 * keys are already portable.
 */
const configConditionIn = z.object({ in: z.array(z.string().min(1).max(200)).min(1).max(50) });
export const configApplicabilityConditionsSchema = z
  .object({
    legal_entity_id: configConditionIn.optional(),
    country_code: configConditionIn.optional(),
    business_unit_id: configConditionIn.optional(),
    location_id: configConditionIn.optional(),
    job_function_id: configConditionIn.optional(),
    job_level_rank: z
      .object({
        min: z.number().int().nullable().optional(),
        max: z.number().int().nullable().optional(),
      })
      .optional(),
    job_profile_id: configConditionIn.optional(),
    employment_type_key: configConditionIn.optional(),
    requisition_type_key: configConditionIn.optional(),
  })
  .strict();
export type ConfigApplicabilityConditions = z.infer<typeof configApplicabilityConditionsSchema>;

export const configTemplateAssignmentSchema = z.object({
  templateKind: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().min(1).max(120),
  /** The target template's natural key (loop key / scorecard key). */
  template: z.string().min(1).max(200),
  priority: z.number().int().min(-1000).max(1000),
  isActive: z.boolean(),
  conditions: configApplicabilityConditionsSchema,
});
export type ConfigTemplateAssignment = z.infer<typeof configTemplateAssignmentSchema>;

export const configScorecardTemplateSchema = z.object({
  scorecardKey: snake,
  label: z.string().min(1).max(80),
  criteria: z
    .array(z.object({ key: snake, label: z.string().min(1).max(80) }))
    .min(1)
    .max(10),
});
export type ConfigScorecardTemplate = z.infer<typeof configScorecardTemplateSchema>;

export const configEmailTemplateOverrideSchema = z.object({
  templateKey: z.string().min(1).max(80),
  subjectOverride: z.string().max(300).nullable(),
  slotOverrides: z.record(z.string(), z.string().max(2000)),
  enabled: z.boolean(),
});
export type ConfigEmailTemplateOverride = z.infer<typeof configEmailTemplateOverrideSchema>;

export const configCandidateFieldPolicySchema = z.object({
  fieldKey: z.string().min(1).max(40),
  requiredness: z.enum(["required", "optional"]),
  blocksAdvanceStage: z.string().nullable(),
});
export type ConfigCandidateFieldPolicy = z.infer<typeof configCandidateFieldPolicySchema>;

export const configSourceSchema = z.object({
  sourceEnum: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  enabled: z.boolean(),
  ingestionMode: z.enum(["manual", "connector_pending"]),
  config: z.record(z.string(), z.string()),
  notes: z.string().max(500).nullable(),
});
export type ConfigSource = z.infer<typeof configSourceSchema>;

export const configApprovalMatrixSchema = z.object({
  subjectType: z.enum(["requisition", "offer"]),
  name: z.string().min(1).max(120),
  rules: z.record(z.string(), z.unknown()),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
});
export type ConfigApprovalMatrix = z.infer<typeof configApprovalMatrixSchema>;

/** Panel pools are exported as STRUCTURE only (name, focus) — never members. */
export const configPanelPoolSchema = z.object({
  name: z.string().min(1).max(120),
  focus: z.string().nullable(),
  isArchived: z.boolean(),
});
export type ConfigPanelPool = z.infer<typeof configPanelPoolSchema>;

export const configJdTemplateSchema = z.object({
  title: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  roleFamily: z.string(),
  seniority: z.string(),
  locationType: z.enum(["remote", "hybrid", "onsite", "multi"]),
  budgetMinInr: z.number().int().min(0),
  budgetMaxInr: z.number().int().min(0),
  extraContext: z.string(),
  bodyMd: z.string(),
  legalClauses: z.string(),
  skills: z.array(z.unknown()),
  isArchived: z.boolean(),
  sortOrder: z.number().int(),
});
export type ConfigJdTemplate = z.infer<typeof configJdTemplateSchema>;

/**
 * Tenant onboarding document types (UAN, PF, ESIC, …). Applied only on a
 * schema where `document_types` is tenant-scoped (C1-BUGS BUG-4); on a schema
 * where the table is still global the section is skipped and reported.
 */
export const configDocumentTypeSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  geographyCode: iso2.nullable(),
  requiredForLifecycleStage: z.string().nullable(),
  retentionYears: z.number().int().nullable(),
});
export type ConfigDocumentType = z.infer<typeof configDocumentTypeSchema>;

export const tenantConfigSectionsSchema = z.object({
  /** Exportable `tenants.settings` blocks (allowlist: TENANT_SETTINGS_BLOCKS). */
  settings: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  locale: configLocaleSchema.optional(),
  lookups: z.array(configLookupSchema).optional(),
  legalEntities: z.array(configLegalEntitySchema).optional(),
  locations: z.array(configLocationSchema).optional(),
  businessUnits: z.array(configBusinessUnitSchema).optional(),
  jobFunctions: z.array(configJobFunctionSchema).optional(),
  jobLevels: z.array(configJobLevelSchema).optional(),
  jdTemplates: z.array(configJdTemplateSchema).optional(),
  jobProfiles: z.array(configJobProfileSchema).optional(),
  compBands: z.array(configCompBandSchema).optional(),
  scorecardTemplates: z.array(configScorecardTemplateSchema).optional(),
  interviewLoops: z.array(configInterviewLoopSchema).optional(),
  interviewRounds: z.array(configInterviewRoundSchema).optional(),
  templateAssignments: z.array(configTemplateAssignmentSchema).optional(),
  emailTemplateOverrides: z.array(configEmailTemplateOverrideSchema).optional(),
  candidateFieldPolicy: z.array(configCandidateFieldPolicySchema).optional(),
  sources: z.array(configSourceSchema).optional(),
  approvalMatrices: z.array(configApprovalMatrixSchema).optional(),
  panelPools: z.array(configPanelPoolSchema).optional(),
  documentTypes: z.array(configDocumentTypeSchema).optional(),
});
export type TenantConfigSections = z.infer<typeof tenantConfigSectionsSchema>;
export type TenantConfigSectionKey = keyof TenantConfigSections;

/**
 * Apply order: referenced sections before the sections that reference them
 * (entities → locations → business units; functions/levels/JD templates →
 * profiles → comp bands; scorecards → loops → rounds; everything → template
 * assignments, whose targets and conditions reference all of the above).
 */
export const TENANT_CONFIG_SECTION_ORDER: readonly TenantConfigSectionKey[] = [
  "locale",
  "settings",
  "lookups",
  "legalEntities",
  "locations",
  "businessUnits",
  "jobFunctions",
  "jobLevels",
  "jdTemplates",
  "jobProfiles",
  "compBands",
  "scorecardTemplates",
  "interviewLoops",
  "interviewRounds",
  "templateAssignments",
  "emailTemplateOverrides",
  "candidateFieldPolicy",
  "sources",
  "approvalMatrices",
  "panelPools",
  "documentTypes",
];

export const TENANT_CONFIG_SECTION_LABELS: Record<TenantConfigSectionKey, string> = {
  settings: "Settings blocks",
  locale: "Locale",
  lookups: "Lists",
  legalEntities: "Legal entities",
  locations: "Locations",
  businessUnits: "Business units",
  jobFunctions: "Job functions",
  jobLevels: "Job levels",
  jdTemplates: "JD templates",
  jobProfiles: "Job profiles",
  compBands: "Comp bands",
  scorecardTemplates: "Scorecard templates",
  interviewLoops: "Interview loops",
  interviewRounds: "Interview rounds",
  templateAssignments: "Template assignments (applicability)",
  emailTemplateOverrides: "Email template overrides",
  candidateFieldPolicy: "Candidate field policy",
  sources: "Sources",
  approvalMatrices: "Approval routing",
  panelPools: "Panel pools (structure only)",
  documentTypes: "Document types",
};

/**
 * What a REMOVAL means per section (never a hard delete of anything a
 * business record can reference).
 */
export const TENANT_CONFIG_REMOVAL_MODE: Record<
  TenantConfigSectionKey,
  "reset" | "deactivate" | "archive" | "end_date" | "none"
> = {
  settings: "reset",
  locale: "none",
  lookups: "reset",
  legalEntities: "deactivate",
  locations: "deactivate",
  businessUnits: "archive",
  jobFunctions: "deactivate",
  jobLevels: "deactivate",
  jdTemplates: "archive",
  jobProfiles: "deactivate",
  compBands: "archive",
  scorecardTemplates: "reset",
  interviewLoops: "deactivate",
  interviewRounds: "reset",
  templateAssignments: "reset",
  emailTemplateOverrides: "reset",
  candidateFieldPolicy: "reset",
  sources: "reset",
  approvalMatrices: "end_date",
  panelPools: "archive",
  documentTypes: "none",
};

/** The document itself. */
export const tenantConfigDocumentSchema = z.object({
  format: z.literal(TENANT_CONFIG_FORMAT),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  source: z
    .object({
      tenantSlug: z.string().nullable(),
      starterPack: z.object({ key: z.string(), version: z.number().int() }).nullable(),
    })
    .optional(),
  sections: tenantConfigSectionsSchema,
});
export type TenantConfigDocument = z.infer<typeof tenantConfigDocumentSchema>;

export type ParseConfigDocumentResult =
  | { ok: true; document: TenantConfigDocument }
  | { ok: false; error: string };

/**
 * Parse an uploaded document. Refuses another format, another (cross-version
 * incompatible) schemaVersion, or a malformed section.
 */
export function parseTenantConfigDocument(raw: unknown): ParseConfigDocumentResult {
  if (!isRecord(raw) || raw.format !== TENANT_CONFIG_FORMAT) {
    return { ok: false, error: "Not a HireOps tenant configuration file." };
  }
  if (raw.schemaVersion !== TENANT_CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Configuration file version ${String(raw.schemaVersion)} is not compatible with this platform (expects version ${TENANT_CONFIG_SCHEMA_VERSION}).`,
    };
  }
  const p = tenantConfigDocumentSchema.safeParse(raw);
  if (!p.success) {
    const issue = p.error.issues[0];
    return {
      ok: false,
      error: `Invalid configuration file at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`,
    };
  }
  return { ok: true, document: p.data };
}

// ─────────────────────────── diff ───────────────────────────

/**
 * Natural key of an interview round: the bare round number for the 'default'
 * loop (byte-identical to documents from before named loops), else
 * `<loopKey>:<roundNumber>`.
 */
export function interviewRoundRecordKey(loopKey: unknown, roundNumber: unknown): string {
  const k = typeof loopKey === "string" && loopKey !== "" ? loopKey : "default";
  return k === "default" ? String(roundNumber) : `${k}:${String(roundNumber)}`;
}

/** Inverse of interviewRoundRecordKey. */
export function parseInterviewRoundRecordKey(key: string): {
  loopKey: string;
  roundNumber: number;
} {
  const i = key.lastIndexOf(":");
  if (i < 0) return { loopKey: "default", roundNumber: Number(key) };
  return { loopKey: key.slice(0, i), roundNumber: Number(key.slice(i + 1)) };
}

/** Natural key per record, per section. */
export function configRecordKey(section: TenantConfigSectionKey, rec: unknown): string {
  const r = rec as Json;
  switch (section) {
    case "lookups":
      return `${String(r.kind)}:${String(r.key)}`;
    case "legalEntities":
    case "locations":
    case "compBands":
    case "panelPools":
      return String(r.name);
    case "businessUnits":
      return String(r.slug);
    case "jobFunctions":
    case "jobLevels":
      return String(r.key);
    case "jdTemplates":
    case "jobProfiles":
      return String(r.title);
    case "scorecardTemplates":
      return String(r.scorecardKey);
    case "interviewLoops":
      return String(r.loopKey);
    case "interviewRounds":
      return interviewRoundRecordKey(r.loopKey, r.roundNumber);
    case "templateAssignments":
      return `${String(r.templateKind)}:${String(r.name)}`;
    case "emailTemplateOverrides":
      return String(r.templateKey);
    case "candidateFieldPolicy":
      return String(r.fieldKey);
    case "sources":
      return String(r.sourceEnum);
    case "approvalMatrices":
      return `${String(r.subjectType)}:${String(r.name)}`;
    case "documentTypes":
      return String(r.code);
    default:
      return "";
  }
}

/** Is a CURRENT record still "live" (so its absence from the incoming file is a removal)? */
function isLive(section: TenantConfigSectionKey, rec: Json): boolean {
  const mode = TENANT_CONFIG_REMOVAL_MODE[section];
  if (mode === "deactivate") return rec.isActive !== false;
  if (mode === "archive") return rec.isArchived !== true;
  if (mode === "end_date") {
    const to = rec.effectiveTo;
    return to === null || to === undefined || Date.parse(String(to)) > Date.now();
  }
  return true;
}

/** Deterministic JSON (sorted object keys) for record comparison. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface ConfigSectionDiff {
  section: TenantConfigSectionKey;
  label: string;
  adds: string[];
  changes: string[];
  removals: string[];
  /** Notes the operator should read (e.g. a settings block the resolver will normalise). */
  warnings: string[];
}

/**
 * Per-section diff of CURRENT (the target tenant's export) against INCOMING.
 * Only sections present in `incoming` are compared. `mode: "additive"` (the
 * starter-pack path) reports adds only — existing values are never changed
 * or removed.
 */
export function diffTenantConfig(
  current: TenantConfigSections,
  incoming: TenantConfigSections,
  mode: "replace" | "additive" = "replace",
): ConfigSectionDiff[] {
  const out: ConfigSectionDiff[] = [];
  for (const section of TENANT_CONFIG_SECTION_ORDER) {
    const inc = incoming[section];
    if (inc === undefined) continue;
    const d: ConfigSectionDiff = {
      section,
      label: TENANT_CONFIG_SECTION_LABELS[section],
      adds: [],
      changes: [],
      removals: [],
      warnings: [],
    };

    if (section === "settings") {
      const cur = (current.settings ?? {}) as Record<string, Json>;
      const nxt = inc as Record<string, Json>;
      for (const [key, block] of Object.entries(nxt)) {
        const def = settingsBlockDef(key);
        if (!def) {
          d.warnings.push(`${key}: not a configurable settings block — ignored`);
          continue;
        }
        if (!isJsonSubset(block, def.normalize(block))) {
          d.warnings.push(`${key}: some values are outside the allowed range and read as defaults`);
        }
        if (!(key in cur)) d.adds.push(key);
        else if (mode === "replace" && stableJson(cur[key]) !== stableJson(block))
          d.changes.push(key);
      }
      if (mode === "replace") {
        for (const key of Object.keys(cur)) if (!(key in nxt)) d.removals.push(key);
      }
    } else if (section === "locale") {
      const cur = (current.locale ?? { currency: null, timezone: null, locale: null }) as Json;
      const nxt = inc as Json;
      for (const f of TENANT_CONFIG_LOCALE_FIELDS) {
        if (nxt[f] === null || nxt[f] === undefined) continue;
        if (cur[f] === null || cur[f] === undefined) d.adds.push(f);
        else if (mode === "replace" && cur[f] !== nxt[f]) d.changes.push(f);
      }
    } else {
      const curList = ((current[section] ?? []) as Json[]).map(
        (r) => [configRecordKey(section, r), r] as const,
      );
      const curMap = new Map(curList);
      const incList = inc as Json[];
      const incKeys = new Set<string>();
      for (const rec of incList) {
        const k = configRecordKey(section, rec);
        if (incKeys.has(k)) {
          d.warnings.push(`${k}: listed twice — the last entry wins`);
        }
        incKeys.add(k);
      }
      // Last entry wins for duplicates.
      const incMap = new Map(incList.map((r) => [configRecordKey(section, r), r] as const));
      for (const [k, rec] of incMap) {
        const existing = curMap.get(k);
        if (!existing) d.adds.push(k);
        else if (mode === "replace" && stableJson(existing) !== stableJson(rec)) d.changes.push(k);
      }
      if (mode === "replace" && TENANT_CONFIG_REMOVAL_MODE[section] !== "none") {
        for (const [k, rec] of curMap) {
          if (!incMap.has(k) && isLive(section, rec)) d.removals.push(k);
        }
      }
    }
    out.push(d);
  }
  return out;
}

export function configDiffIsEmpty(diff: readonly ConfigSectionDiff[]): boolean {
  return diff.every((d) => d.adds.length + d.changes.length + d.removals.length === 0);
}

// ─────────────────────────── procedure contracts ───────────────────────────

export const configSectionDiffSchema = z.object({
  section: z.string(),
  label: z.string(),
  adds: z.array(z.string()),
  changes: z.array(z.string()),
  removals: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const exportTenantConfigInputSchema = z.object({}).default({});
/** The document travels as a JSON value; clients download it as a .json file. */
export const exportTenantConfigOutputSchema = z.object({
  document: tenantConfigDocumentSchema,
  /** Sections the exporter skipped (e.g. tenant document types not on this schema). */
  skipped: z.array(z.string()),
});
export type ExportTenantConfigOutput = z.infer<typeof exportTenantConfigOutputSchema>;

/** Upload cap: a real configuration is tens of KB. */
export const TENANT_CONFIG_MAX_BYTES = 2_000_000;

export const previewTenantConfigImportInputSchema = z.object({
  /** The raw parsed JSON of the uploaded file; validated server-side. */
  document: z.unknown(),
});
export const previewTenantConfigImportOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  diff: z.array(configSectionDiffSchema),
  empty: z.boolean(),
  /** Echo the incoming file's fingerprint; apply must present the same one. */
  fingerprint: z.string().nullable(),
});
export type PreviewTenantConfigImportOutput = z.infer<typeof previewTenantConfigImportOutputSchema>;

export const applyTenantConfigImportInputSchema = z.object({
  document: z.unknown(),
  /** The fingerprint the operator reviewed in the dry run. */
  fingerprint: z.string().min(8).max(128),
});
export const applyTenantConfigImportOutputSchema = z.object({
  applied: z.array(configSectionDiffSchema),
  skipped: z.array(z.string()),
});
export type ApplyTenantConfigImportOutput = z.infer<typeof applyTenantConfigImportOutputSchema>;

/** FNV-1a 32-bit ×2 over the stable JSON — a review token, not a security hash. */
export function configFingerprint(doc: unknown): string {
  const s = stableJson(doc);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}${s.length.toString(16)}`;
}
