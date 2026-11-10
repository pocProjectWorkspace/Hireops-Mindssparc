/**
 * PC-26 — diverse-slate requirement per role.
 *
 * Some employers require that, before an offer, each role's slate holds at
 * least N candidates who self-identify as diverse. HireOps flags a role whose
 * slate falls short EARLY (shortlist / interview), never blocks: the
 * compliance decision itself stays with the employer's system of record.
 *
 * This is the first place the platform holds demographic data, so the
 * contracts here carry the guardrails rather than leaving them to call sites:
 *
 *   - Self-identification is VOLUNTARY. "Prefer not to say" is the default and
 *     is never stored — choosing it (or withdrawing) leaves no active row.
 *   - Raw answers live in their own table (candidate_diversity_self_id, 0126)
 *     and leave it only as COUNTS per requisition (`DiverseSlateStatus`).
 *     No schema in this file carries a per-person value outward to staff;
 *     the only per-person read is the candidate reading their OWN answers.
 *   - Counts are visible only to DIVERSE_SLATE_VIEW_ROLES, and never with a
 *     list of which candidates were counted.
 *   - What counts as "diverse", the minimum and which stages form the slate
 *     are TENANT configuration (`diversitySlate` block in tenants.settings),
 *     with a platform default. Nothing client-specific lives in code.
 *   - The disclosure copy is versioned; any wording change bumps
 *     DIVERSITY_SELF_ID_DISCLOSURE_VERSION and every stored row records the
 *     version the candidate saw.
 */

import { z } from "zod";
import { applicationStageSchema, type ApplicationStage } from "./enums";

// ─────────────────────────── roles ───────────────────────────

/**
 * Roles that may see slate COUNTS (never per-candidate values). One constant
 * so a later per-tenant override has exactly one place to hook in.
 */
export const DIVERSE_SLATE_VIEW_ROLES = ["admin", "hr_head", "recruiter"] as const;

/** Roles that may edit the tenant `diversitySlate` block. */
export const DIVERSE_SLATE_ADMIN_ROLES = ["admin", "hr_head"] as const;

export function canViewDiverseSlate(roles: readonly string[]): boolean {
  return roles.some((r) => (DIVERSE_SLATE_VIEW_ROLES as readonly string[]).includes(r));
}

// ─────────────────────────── disclosure (versioned copy) ───────────────────────────

/**
 * Stamped on every candidate_diversity_self_id row. Changing ANY word of
 * DIVERSITY_SELF_ID_DISCLOSURE must bump this in the same commit — a stored
 * answer must point at the exact wording the candidate agreed to.
 */
export const DIVERSITY_SELF_ID_DISCLOSURE_VERSION = "diversity-self-id-2026-11-v1";

/** UI-only sentinel for "Prefer not to say". NEVER stored. */
export const DIVERSITY_PREFER_NOT_TO_SAY = "prefer_not_to_say";

export interface DiversitySelfIdDisclosure {
  version: string;
  title: string;
  /** Paragraphs, in order. `{company}` is replaced with the tenant's name. */
  body: string[];
  preferNotToSayLabel: string;
  /** Hard-coded true: the wording is a draft pending the client's legal review. */
  legalReviewRequired: true;
}

/**
 * PLACEHOLDER COPY — pending the client's legal / D&I review. Every promise
 * here is one the code keeps: optional + default "prefer not to say" (no row
 * is written for it), purpose-limited (only the per-role slate count reads
 * it), separate storage, never on staff surfaces / partner portal / exports /
 * AI prompts, and changeable or withdrawable from the candidate portal.
 */
export const DIVERSITY_SELF_ID_DISCLOSURE: DiversitySelfIdDisclosure = {
  version: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
  title: "Diversity information (optional)",
  body: [
    "Answering is entirely optional. “Prefer not to say” is selected unless you choose " +
      "otherwise, and not answering has no effect on your application.",
    "{company} uses this only to check that each role's interview slate meets diversity " +
      "requirements. It is never used to screen or score you.",
    "Your answer is stored separately from your application. Recruiters, interviewers and " +
      "recruitment agencies never see it, and it is never given to any AI system. It is only " +
      "ever counted, as a number per role, together with other candidates' answers.",
    "You can change or withdraw your answer at any time from My Profile in the candidate portal.",
  ],
  preferNotToSayLabel: "Prefer not to say",
  legalReviewRequired: true,
};

/** Render the disclosure body for a tenant. */
export function renderDiversityDisclosureBody(companyName: string): string[] {
  return DIVERSITY_SELF_ID_DISCLOSURE.body.map((p) => p.split("{company}").join(companyName));
}

// ─────────────────────────── tenant settings block ───────────────────────────

export const DIVERSITY_SLATE_SETTINGS_VERSION = 1 as const;
/** Upper bound on a required minimum (per tenant default and per role). */
export const DIVERSE_SLATE_MIN_MAX = 20;

const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "lower-case letters, digits and underscores");

export const diversityCategoryOptionSchema = z.object({
  /** Stored value. Must not be the "prefer not to say" sentinel. */
  value: slugSchema.refine((v) => v !== DIVERSITY_PREFER_NOT_TO_SAY, "reserved value"),
  /** Candidate-facing label. */
  label: z.string().trim().min(1).max(80),
  /** Whether an active answer with this value counts toward the slate. */
  countsAsDiverse: z.boolean(),
});
export type DiversityCategoryOption = z.infer<typeof diversityCategoryOptionSchema>;

export const diversityCategorySchema = z.object({
  key: slugSchema,
  /** Candidate-facing question label, e.g. "Gender". */
  label: z.string().trim().min(1).max(80),
  options: z.array(diversityCategoryOptionSchema).min(1).max(12),
});
export type DiversityCategory = z.infer<typeof diversityCategorySchema>;

/** Platform default: shortlisted + the interview stages through offer drafted. */
export const DEFAULT_DIVERSE_SLATE_COUNTED_STAGES: ApplicationStage[] = [
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
];

/** Platform default categories: gender; woman / non-binary / self-described count. */
export function defaultDiversityCategories(): DiversityCategory[] {
  return [
    {
      key: "gender",
      label: "Gender",
      options: [
        { value: "woman", label: "Woman", countsAsDiverse: true },
        { value: "man", label: "Man", countsAsDiverse: false },
        { value: "non_binary", label: "Non-binary", countsAsDiverse: true },
        { value: "self_described", label: "I describe myself another way", countsAsDiverse: true },
      ],
    },
  ];
}

export const diversitySlateSettingsSchema = z
  .object({
    version: z.literal(DIVERSITY_SLATE_SETTINGS_VERSION).default(DIVERSITY_SLATE_SETTINGS_VERSION),
    /**
     * Master switch. OFF by default: a tenant that never opens the admin page
     * collects nothing and flags nothing.
     */
    enabled: z.boolean().default(false),
    /** Minimum diverse candidates in the slate, used when a role doesn't set its own. */
    defaultMin: z.number().int().min(1).max(DIVERSE_SLATE_MIN_MAX).default(2),
    /** Application stages whose candidates make up "the slate". */
    countedStages: z
      .array(applicationStageSchema)
      .min(1)
      .max(11)
      .default(() => [...DEFAULT_DIVERSE_SLATE_COUNTED_STAGES]),
    categories: z
      .array(diversityCategorySchema)
      .min(1)
      .max(5)
      .default(() => defaultDiversityCategories()),
  })
  .superRefine((v, ctx) => {
    const keys = new Set<string>();
    v.categories.forEach((c, i) => {
      if (keys.has(c.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["categories", i, "key"],
          message: "duplicate key",
        });
      }
      keys.add(c.key);
      const values = new Set<string>();
      c.options.forEach((o, j) => {
        if (values.has(o.value)) {
          ctx.addIssue({
            code: "custom",
            path: ["categories", i, "options", j, "value"],
            message: "duplicate value",
          });
        }
        values.add(o.value);
      });
    });
    if (new Set(v.countedStages).size !== v.countedStages.length) {
      ctx.addIssue({ code: "custom", path: ["countedStages"], message: "duplicate stage" });
    }
  });
export type DiversitySlateSettings = z.infer<typeof diversitySlateSettingsSchema>;

export function defaultDiversitySlateSettings(): DiversitySlateSettings {
  return diversitySlateSettingsSchema.parse({});
}

/**
 * Merge a raw stored `diversitySlate` block with defaults. NEVER throws — a
 * malformed blob falls back to the platform default (which is disabled), so a
 * stale settings blob can neither break a page nor switch collection on.
 */
export function resolveDiversitySlateSettings(rawBlock: unknown): DiversitySlateSettings {
  try {
    const parsed = diversitySlateSettingsSchema.safeParse(rawBlock ?? {});
    return parsed.success ? parsed.data : defaultDiversitySlateSettings();
  } catch {
    return defaultDiversitySlateSettings();
  }
}

/** "category:value" pairs that count toward the slate under these settings. */
export function qualifyingSelfIdPairs(settings: DiversitySlateSettings): string[] {
  const out: string[] = [];
  for (const c of settings.categories) {
    for (const o of c.options) {
      if (o.countsAsDiverse) out.push(`${c.key}:${o.value}`);
    }
  }
  return out;
}

// ─────────────────────────── slate status (counts only) ───────────────────────────

export const diverseSlateStatusValueSchema = z.enum(["met", "short", "not_required"]);
export type DiverseSlateStatusValue = z.infer<typeof diverseSlateStatusValueSchema>;

/**
 * The ONLY shape in which self-ID data leaves the server to staff: an
 * aggregate count per requisition. No candidate ids, no per-category split.
 * `requiredMin` / `diverseInSlate` are null when no requirement applies.
 */
export const diverseSlateStatusSchema = z.object({
  requisitionId: z.string().uuid(),
  status: diverseSlateStatusValueSchema,
  requiredMin: z.number().int().nullable(),
  diverseInSlate: z.number().int().nullable(),
});
export type DiverseSlateStatus = z.infer<typeof diverseSlateStatusSchema>;

/** Pure status rule shared by the server and the tests. */
export function computeDiverseSlateStatus(params: {
  tenantEnabled: boolean;
  required: boolean;
  roleMin: number | null;
  tenantDefaultMin: number;
  qualifyingCount: number;
}): Omit<DiverseSlateStatus, "requisitionId"> {
  if (!params.tenantEnabled || !params.required) {
    return { status: "not_required", requiredMin: null, diverseInSlate: null };
  }
  const min = params.roleMin ?? params.tenantDefaultMin;
  return {
    status: params.qualifyingCount >= min ? "met" : "short",
    requiredMin: min,
    diverseInSlate: params.qualifyingCount,
  };
}

/** Stages whose ENTRY should warn when the role is short (interview + offer). */
export const DIVERSE_SLATE_WARN_STAGES: ApplicationStage[] = [
  "tech_interview",
  "hr_round",
  "offer_drafted",
];

/** Badge copy, e.g. "Diverse slate: 1/2 — short". */
export function diverseSlateLabel(
  s: Pick<DiverseSlateStatus, "status" | "requiredMin" | "diverseInSlate">,
): string | null {
  if (s.status === "not_required" || s.requiredMin == null || s.diverseInSlate == null) return null;
  return `Diverse slate: ${s.diverseInSlate}/${s.requiredMin}${s.status === "short" ? " — short" : " — met"}`;
}

export const getDiverseSlateStatusInputSchema = z
  .object({
    requisitionId: z.string().uuid().optional(),
    /** Convenience for surfaces that only hold an application (offer / interview). */
    applicationId: z.string().uuid().optional(),
  })
  .refine((v) => !!v.requisitionId !== !!v.applicationId, {
    message: "pass exactly one of requisitionId / applicationId",
  });
export type GetDiverseSlateStatusInput = z.infer<typeof getDiverseSlateStatusInputSchema>;
export const getDiverseSlateStatusOutputSchema = diverseSlateStatusSchema;

export const listDiverseSlateStatusesInputSchema = z
  .object({ onlyShort: z.boolean().default(false) })
  .default({ onlyShort: false });
export const diverseSlateRoleRowSchema = diverseSlateStatusSchema.extend({
  title: z.string().nullable(),
});
export type DiverseSlateRoleRow = z.infer<typeof diverseSlateRoleRowSchema>;
export const listDiverseSlateStatusesOutputSchema = z.object({
  /** False when the tenant has the feature off — surfaces render nothing. */
  enabled: z.boolean(),
  /** Open requisitions (approved / posted / on hold) that require a diverse slate. */
  rows: z.array(diverseSlateRoleRowSchema),
});
export type ListDiverseSlateStatusesOutput = z.infer<typeof listDiverseSlateStatusesOutputSchema>;

// ─────────────────────────── admin get / update ───────────────────────────

export const getDiversitySlateSettingsOutputSchema = diversitySlateSettingsSchema;
export const updateDiversitySlateSettingsInputSchema = diversitySlateSettingsSchema;
export const updateDiversitySlateSettingsOutputSchema = z.object({
  ok: z.literal(true),
  settings: diversitySlateSettingsSchema,
});

/**
 * What the requisition wizard needs: whether the toggle shows, and its
 * default minimum. Readable by requisition writers (not sensitive).
 */
export const getDiverseSlateDefaultsOutputSchema = z.object({
  enabled: z.boolean(),
  defaultMin: z.number().int(),
});
export type GetDiverseSlateDefaultsOutput = z.infer<typeof getDiverseSlateDefaultsOutputSchema>;

// ─────────────────────────── candidate capture ───────────────────────────

/**
 * Candidate-facing capture config: the questions and option labels only —
 * which values COUNT is deliberately not sent (it is irrelevant to the
 * candidate and invites gaming).
 */
export const diversityCaptureConfigSchema = z.object({
  enabled: z.boolean(),
  disclosureVersion: z.string(),
  title: z.string(),
  body: z.array(z.string()),
  preferNotToSayLabel: z.string(),
  categories: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      options: z.array(z.object({ value: z.string(), label: z.string() })),
    }),
  ),
});
export type DiversityCaptureConfig = z.infer<typeof diversityCaptureConfigSchema>;

export function toDiversityCaptureConfig(
  settings: DiversitySlateSettings,
  companyName: string,
): DiversityCaptureConfig {
  return {
    enabled: settings.enabled,
    disclosureVersion: DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
    title: DIVERSITY_SELF_ID_DISCLOSURE.title,
    body: renderDiversityDisclosureBody(companyName),
    preferNotToSayLabel: DIVERSITY_SELF_ID_DISCLOSURE.preferNotToSayLabel,
    categories: settings.enabled
      ? settings.categories.map((c) => ({
          key: c.key,
          label: c.label,
          options: c.options.map((o) => ({ value: o.value, label: o.label })),
        }))
      : [],
  };
}

export const diversitySelfIdAnswerSchema = z.object({
  categoryKey: slugSchema,
  /** An option value, or DIVERSITY_PREFER_NOT_TO_SAY (= no row / withdraw). */
  value: slugSchema,
});
export type DiversitySelfIdAnswer = z.infer<typeof diversitySelfIdAnswerSchema>;

export const diversitySelfIdSubmissionSchema = z.object({
  /** Must equal DIVERSITY_SELF_ID_DISCLOSURE_VERSION (the copy the candidate saw). */
  disclosureVersion: z.string().min(1).max(60),
  answers: z.array(diversitySelfIdAnswerSchema).max(5),
});
export type DiversitySelfIdSubmission = z.infer<typeof diversitySelfIdSubmissionSchema>;

/**
 * Validate a submission against the tenant's CURRENT categories. Drops
 * unknown categories / values (a stale form must not store a value the tenant
 * no longer offers). Returns per-category intent: the value to store, or null
 * for "prefer not to say" (= withdraw any active answer).
 */
export function normaliseDiversitySelfIdSubmission(
  submission: DiversitySelfIdSubmission,
  settings: DiversitySlateSettings,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const a of submission.answers) {
    const cat = settings.categories.find((c) => c.key === a.categoryKey);
    if (!cat) continue;
    if (a.value === DIVERSITY_PREFER_NOT_TO_SAY) {
      out.set(cat.key, null);
      continue;
    }
    if (cat.options.some((o) => o.value === a.value)) out.set(cat.key, a.value);
  }
  return out;
}

/** The candidate's OWN active answers — returned only to that candidate. */
export const candidateGetDiversitySelfIdOutputSchema = z.object({
  config: diversityCaptureConfigSchema,
  answers: z.array(diversitySelfIdAnswerSchema),
});
export type CandidateGetDiversitySelfIdOutput = z.infer<
  typeof candidateGetDiversitySelfIdOutputSchema
>;
export const candidateSetDiversitySelfIdInputSchema = diversitySelfIdSubmissionSchema;
export const candidateSetDiversitySelfIdOutputSchema = candidateGetDiversitySelfIdOutputSchema;
