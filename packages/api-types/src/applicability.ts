import { z } from "zod";

/**
 * C2-F12 — the APPLICABILITY resolver (Plan A §15 P3, foundation F12).
 *
 * One shared answer to "which template applies to this requisition?". Every
 * template kind (interview loop, scorecard, approval chain, BGV package, …) is
 * assigned to requisitions by RULES over a fixed, typed attribute set instead
 * of each feature growing its own "per band / per function" switch.
 *
 * A `template_assignments` row says: for template kind K, use template T when
 * the requisition satisfies CONDITIONS. Conditions are an AND of predicates:
 *
 *   - `in: [...]` over an id / key attribute (legal entity, country, business
 *     unit, location, job function, job profile, employment type, requisition
 *     type). `business_unit_id` also matches every DESCENDANT unit: the subject
 *     carries its unit plus all ancestors, so "Finance" covers "Finance › AP".
 *   - `{ min, max }` over the job level RANK (inclusive; either bound may be
 *     omitted, not both).
 *
 * Empty conditions = the default assignment for that kind (matches everything,
 * zero specificity).
 *
 * Ranking — most specific wins:
 *   1. the number of satisfied predicates (more = more specific);
 *   2. then `priority` (HIGHER wins);
 *   3. then the newest assignment (created_at, later wins);
 *   4. then the id, purely so the result is deterministic.
 * Assignments level with the winner on (1) and (2) are reported as `ties` so an
 * admin sees that only recency decided it.
 *
 * No match → null. The CALLER then falls back to today's per-tenant behaviour
 * (e.g. the tenant's single default interview loop), so a tenant with no
 * assignments behaves exactly as before.
 *
 * Pure zod + pure functions: no I/O. The DB loader lives in the api
 * (apps/api/src/lib/applicability.ts).
 */

// ─────────────────────────── kinds ───────────────────────────

/**
 * Template kinds the resolver serves. A platform constant (adding one is a code
 * change); the DB column is format-checked only, like tenant_lookups.kind.
 * Only interview_loop and scorecard have consumers today — the rest are
 * reserved so F4 / F5 / F6 consumers plug in without a schema change.
 */
export const TEMPLATE_KINDS = [
  "interview_loop",
  "scorecard",
  "approval_chain",
  "bgv_package",
  "document_set",
  "onboarding_checklist",
  "email_template_set",
  "sla_profile",
] as const;
export const templateKindSchema = z.enum(TEMPLATE_KINDS);
export type TemplateKind = z.infer<typeof templateKindSchema>;

export interface TemplateKindMeta {
  label: string;
  description: string;
  /** Does anything consume a resolved template of this kind yet? */
  consumed: boolean;
  /** What happens when no assignment matches (shown in the preview). */
  fallback: string;
}

export const TEMPLATE_KIND_META: Record<TemplateKind, TemplateKindMeta> = {
  interview_loop: {
    label: "Interview loop",
    description: "Which named interview loop seeds a requisition's interview plan.",
    consumed: true,
    fallback: "The tenant's default interview loop.",
  },
  scorecard: {
    label: "Scorecard",
    description: "Which scorecard a loop round uses when the round does not pin one explicitly.",
    consumed: true,
    fallback: "The round's pinned scorecard, else the built-in General scorecard.",
  },
  approval_chain: {
    label: "Approval chain",
    description: "Reserved — consumed when the process engine (F4) lands.",
    consumed: false,
    fallback: "Today's approval routing (not yet driven by applicability).",
  },
  bgv_package: {
    label: "BGV package",
    description: "Reserved — consumed when BGV packages land.",
    consumed: false,
    fallback: "Today's BGV behaviour (not yet driven by applicability).",
  },
  document_set: {
    label: "Document set",
    description: "Reserved — consumed when document sets land.",
    consumed: false,
    fallback: "Today's document types (not yet driven by applicability).",
  },
  onboarding_checklist: {
    label: "Onboarding checklist",
    description: "Reserved — consumed when onboarding checklists land.",
    consumed: false,
    fallback: "Today's onboarding checklist (not yet driven by applicability).",
  },
  email_template_set: {
    label: "Email template set",
    description: "Reserved — consumed when communications (F6) land.",
    consumed: false,
    fallback: "Today's email templates (not yet driven by applicability).",
  },
  sla_profile: {
    label: "SLA profile",
    description: "Reserved — consumed when SLA profiles land.",
    consumed: false,
    fallback: "Today's SLA thresholds (not yet driven by applicability).",
  },
};

// ─────────────────────────── attributes + conditions ───────────────────────────

/** The fixed attribute set a condition may test. */
export const APPLICABILITY_ATTRIBUTES = [
  "legal_entity_id",
  "country_code",
  "business_unit_id",
  "location_id",
  "job_function_id",
  "job_level_rank",
  "job_profile_id",
  "employment_type_key",
  "requisition_type_key",
] as const;
export type ApplicabilityAttribute = (typeof APPLICABILITY_ATTRIBUTES)[number];

export const APPLICABILITY_ATTRIBUTE_LABELS: Record<ApplicabilityAttribute, string> = {
  legal_entity_id: "Legal entity",
  country_code: "Country",
  business_unit_id: "Business unit (incl. sub-units)",
  location_id: "Location",
  job_function_id: "Job function",
  job_level_rank: "Job level range",
  job_profile_id: "Job profile",
  employment_type_key: "Employment type",
  requisition_type_key: "Requisition type",
};

const MAX_IN = 50;
const uuidIn = z.object({ in: z.array(z.string().uuid()).min(1).max(MAX_IN) }).strict();
const keyIn = z
  .object({
    in: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, "invalid key"),
      )
      .min(1)
      .max(MAX_IN),
  })
  .strict();
const countryIn = z
  .object({
    in: z
      .array(
        z
          .string()
          .trim()
          .transform((s) => s.toUpperCase())
          .pipe(z.string().regex(/^[A-Z]{2}$/, "country must be ISO-3166 alpha-2")),
      )
      .min(1)
      .max(MAX_IN),
  })
  .strict();
const rankRange = z
  .object({
    min: z.number().int().min(0).max(10000).nullable().optional(),
    max: z.number().int().min(0).max(10000).nullable().optional(),
  })
  .strict()
  .refine((r) => r.min != null || r.max != null, {
    message: "a level range needs a minimum, a maximum or both",
  })
  .refine((r) => r.min == null || r.max == null || r.min <= r.max, {
    message: "the minimum rank must not exceed the maximum rank",
  });

export const applicabilityConditionsSchema = z
  .object({
    legal_entity_id: uuidIn.optional(),
    country_code: countryIn.optional(),
    business_unit_id: uuidIn.optional(),
    location_id: uuidIn.optional(),
    job_function_id: uuidIn.optional(),
    job_level_rank: rankRange.optional(),
    job_profile_id: uuidIn.optional(),
    employment_type_key: keyIn.optional(),
    requisition_type_key: keyIn.optional(),
  })
  .strict();
export type ApplicabilityConditions = z.infer<typeof applicabilityConditionsSchema>;

/** Never-throwing read of a stored conditions blob (a malformed blob matches NOTHING). */
export function parseStoredConditions(raw: unknown): ApplicabilityConditions | null {
  const p = applicabilityConditionsSchema.safeParse(raw ?? {});
  return p.success ? p.data : null;
}

/** The predicates present on a conditions object, in attribute order. */
export function conditionAttributes(c: ApplicabilityConditions): ApplicabilityAttribute[] {
  return APPLICABILITY_ATTRIBUTES.filter((a) => c[a] !== undefined);
}

export function isDefaultConditions(c: ApplicabilityConditions): boolean {
  return conditionAttributes(c).length === 0;
}

// ─────────────────────────── subject ───────────────────────────

/**
 * The requisition, seen by the resolver. Built ONCE per requisition by the
 * api loader (loadRequisitionAttributes). An unknown (null) attribute never
 * satisfies a predicate on that attribute.
 */
export interface ApplicabilitySubject {
  legal_entity_id: string | null;
  country_code: string | null;
  business_unit_id: string | null;
  /** The unit itself plus every ancestor (the BU-descendant match). */
  business_unit_lineage: readonly string[];
  location_id: string | null;
  job_function_id: string | null;
  job_level_rank: number | null;
  job_profile_id: string | null;
  employment_type_key: string | null;
  requisition_type_key: string | null;
}

export const EMPTY_APPLICABILITY_SUBJECT: ApplicabilitySubject = {
  legal_entity_id: null,
  country_code: null,
  business_unit_id: null,
  business_unit_lineage: [],
  location_id: null,
  job_function_id: null,
  job_level_rank: null,
  job_profile_id: null,
  employment_type_key: null,
  requisition_type_key: null,
};

/**
 * A unit's lineage: itself, its parent, its parent's parent … (root last).
 * Cycle-safe (a corrupt A → B → A loop stops at the repeat) and depth-capped.
 * An id not in `units` resolves to just itself.
 */
export function businessUnitLineage(
  units: readonly { id: string; parentId: string | null }[],
  businessUnitId: string | null,
): string[] {
  if (!businessUnitId) return [];
  const parent = new Map(units.map((u) => [u.id, u.parentId] as const));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = businessUnitId;
  while (cur && !seen.has(cur) && out.length < 64) {
    seen.add(cur);
    out.push(cur);
    cur = parent.get(cur) ?? null;
  }
  return out;
}

// ─────────────────────────── evaluation ───────────────────────────

export interface ConditionEvaluation {
  matches: boolean;
  matched: ApplicabilityAttribute[];
  failed: ApplicabilityAttribute[];
}

function predicateHolds(
  attr: ApplicabilityAttribute,
  c: ApplicabilityConditions,
  s: ApplicabilitySubject,
): boolean {
  switch (attr) {
    case "business_unit_id": {
      const want = c.business_unit_id?.in ?? [];
      const lineage = s.business_unit_lineage.length
        ? s.business_unit_lineage
        : s.business_unit_id
          ? [s.business_unit_id]
          : [];
      return lineage.some((id) => want.includes(id));
    }
    case "job_level_rank": {
      const r = c.job_level_rank;
      if (!r || s.job_level_rank === null) return false;
      if (r.min != null && s.job_level_rank < r.min) return false;
      if (r.max != null && s.job_level_rank > r.max) return false;
      return true;
    }
    case "country_code": {
      const v = s.country_code?.toUpperCase() ?? null;
      return v !== null && (c.country_code?.in ?? []).includes(v);
    }
    default: {
      const pred = c[attr] as { in: string[] } | undefined;
      const v = s[attr];
      return v !== null && (pred?.in ?? []).includes(v);
    }
  }
}

/** AND of the predicates present; reports which held and which did not. */
export function evaluateConditions(
  conditions: ApplicabilityConditions,
  subject: ApplicabilitySubject,
): ConditionEvaluation {
  const matched: ApplicabilityAttribute[] = [];
  const failed: ApplicabilityAttribute[] = [];
  for (const attr of conditionAttributes(conditions)) {
    (predicateHolds(attr, conditions, subject) ? matched : failed).push(attr);
  }
  return { matches: failed.length === 0, matched, failed };
}

// ─────────────────────────── ranking ───────────────────────────

export interface AssignmentCandidate {
  id: string;
  name: string;
  templateKind: TemplateKind;
  templateId: string;
  priority: number;
  isActive: boolean;
  /** Raw stored conditions (parsed defensively). */
  conditions: unknown;
  createdAt: Date | string;
}

export interface EvaluatedAssignment {
  assignmentId: string;
  name: string;
  templateId: string;
  priority: number;
  isDefault: boolean;
  matches: boolean;
  matchedPredicates: ApplicabilityAttribute[];
  failedPredicates: ApplicabilityAttribute[];
  /** Why the assignment was not considered at all (inactive, malformed, …). */
  skippedReason: string | null;
}

export interface ApplicabilityResolution {
  templateId: string;
  assignmentId: string;
  name: string;
  matchedPredicates: ApplicabilityAttribute[];
  isDefault: boolean;
  priority: number;
  /** Other matching assignments level with the winner on specificity + priority. */
  ties: { assignmentId: string; name: string; templateId: string }[];
}

export interface RankResult {
  winner: ApplicabilityResolution | null;
  evaluated: EvaluatedAssignment[];
}

function ts(v: Date | string): number {
  const n = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Rank a kind's assignments against a subject. `isTargetUsable` lets the
 * caller drop assignments whose target template is missing / inactive (they
 * are reported as skipped, never chosen).
 */
export function rankAssignments(
  kind: TemplateKind,
  assignments: readonly AssignmentCandidate[],
  subject: ApplicabilitySubject,
  isTargetUsable: (templateId: string) => string | null = () => null,
): RankResult {
  const evaluated: EvaluatedAssignment[] = [];
  const live: { a: AssignmentCandidate; e: EvaluatedAssignment }[] = [];
  for (const a of assignments) {
    if (a.templateKind !== kind) continue;
    const parsed = parseStoredConditions(a.conditions);
    const base = {
      assignmentId: a.id,
      name: a.name,
      templateId: a.templateId,
      priority: a.priority,
    };
    if (!parsed) {
      evaluated.push({
        ...base,
        isDefault: false,
        matches: false,
        matchedPredicates: [],
        failedPredicates: [],
        skippedReason: "conditions are malformed",
      });
      continue;
    }
    const ev = evaluateConditions(parsed, subject);
    const targetProblem = a.isActive ? isTargetUsable(a.templateId) : null;
    const e: EvaluatedAssignment = {
      ...base,
      isDefault: isDefaultConditions(parsed),
      matches: ev.matches,
      matchedPredicates: ev.matched,
      failedPredicates: ev.failed,
      skippedReason: !a.isActive ? "inactive" : targetProblem,
    };
    evaluated.push(e);
    if (e.skippedReason === null && e.matches) live.push({ a, e });
  }

  live.sort(
    (x, y) =>
      y.e.matchedPredicates.length - x.e.matchedPredicates.length ||
      y.a.priority - x.a.priority ||
      ts(y.a.createdAt) - ts(x.a.createdAt) ||
      (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0),
  );
  const top = live[0];
  if (!top) return { winner: null, evaluated };
  const ties = live
    .slice(1)
    .filter(
      (o) =>
        o.e.matchedPredicates.length === top.e.matchedPredicates.length &&
        o.a.priority === top.a.priority,
    )
    .map((o) => ({ assignmentId: o.a.id, name: o.a.name, templateId: o.a.templateId }));
  return {
    winner: {
      templateId: top.a.templateId,
      assignmentId: top.a.id,
      name: top.a.name,
      matchedPredicates: top.e.matchedPredicates,
      isDefault: top.e.isDefault,
      priority: top.a.priority,
      ties,
    },
    evaluated,
  };
}

// ─────────────────────────── procedure contracts ───────────────────────────

/** Admin write; hr_head read (list + preview). */
export const APPLICABILITY_WRITE_ROLES = ["admin"] as const;
export const APPLICABILITY_READ_ROLES = ["admin", "hr_head"] as const;

export const templateAssignmentNameSchema = z.string().trim().min(1).max(120);
export const templateAssignmentPrioritySchema = z.number().int().min(-1000).max(1000);

export const templateAssignmentRowSchema = z.object({
  id: z.string().uuid(),
  templateKind: templateKindSchema,
  name: z.string(),
  templateId: z.string().uuid(),
  /** Display label of the target (null when it no longer exists). */
  templateLabel: z.string().nullable(),
  /** Why the target can't be used right now (missing / inactive / empty), or null. */
  templateProblem: z.string().nullable(),
  priority: z.number().int(),
  isActive: z.boolean(),
  conditions: applicabilityConditionsSchema,
  /** True when the stored conditions blob could not be parsed (matches nothing). */
  conditionsMalformed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TemplateAssignmentRow = z.infer<typeof templateAssignmentRowSchema>;

/** A pickable target template of a kind. */
export const templateTargetOptionSchema = z.object({
  kind: templateKindSchema,
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  isActive: z.boolean(),
});
export type TemplateTargetOption = z.infer<typeof templateTargetOptionSchema>;

export const listTemplateAssignmentsInputSchema = z
  .object({ templateKind: templateKindSchema.optional() })
  .default({});
export const listTemplateAssignmentsOutputSchema = z.object({
  assignments: z.array(templateAssignmentRowSchema),
  targets: z.array(templateTargetOptionSchema),
  canWrite: z.boolean(),
});
export type ListTemplateAssignmentsOutput = z.infer<typeof listTemplateAssignmentsOutputSchema>;

export const createTemplateAssignmentInputSchema = z.object({
  templateKind: templateKindSchema,
  name: templateAssignmentNameSchema,
  templateId: z.string().uuid(),
  priority: templateAssignmentPrioritySchema.default(0),
  isActive: z.boolean().default(true),
  conditions: applicabilityConditionsSchema.default({}),
});
export type CreateTemplateAssignmentInput = z.input<typeof createTemplateAssignmentInputSchema>;

export const updateTemplateAssignmentInputSchema = z.object({
  id: z.string().uuid(),
  name: templateAssignmentNameSchema,
  templateId: z.string().uuid(),
  priority: templateAssignmentPrioritySchema,
  isActive: z.boolean(),
  conditions: applicabilityConditionsSchema,
});
export type UpdateTemplateAssignmentInput = z.input<typeof updateTemplateAssignmentInputSchema>;

export const templateAssignmentMutationOutputSchema = z.object({
  row: templateAssignmentRowSchema,
});

export const deleteTemplateAssignmentInputSchema = z.object({ id: z.string().uuid() });
export const deleteTemplateAssignmentOutputSchema = z.object({ deleted: z.boolean() });

/**
 * Attributes for a what-if preview (no requisition yet). The server derives
 * the level rank from the level, the BU lineage from the unit, and — when not
 * given — the legal entity / country from the location or unit, exactly as it
 * does for a real requisition.
 */
export const applicabilityAttributesInputSchema = z
  .object({
    legalEntityId: z.string().uuid().nullable().optional(),
    countryCode: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/))
      .nullable()
      .optional(),
    businessUnitId: z.string().uuid().nullable().optional(),
    locationId: z.string().uuid().nullable().optional(),
    jobFunctionId: z.string().uuid().nullable().optional(),
    jobLevelId: z.string().uuid().nullable().optional(),
    jobProfileId: z.string().uuid().nullable().optional(),
    employmentTypeKey: z.string().trim().min(1).max(40).nullable().optional(),
    requisitionTypeKey: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .strict();
export type ApplicabilityAttributesInput = z.input<typeof applicabilityAttributesInputSchema>;

export const previewResolvedConfigurationInputSchema = z
  .object({
    requisitionId: z.string().uuid().optional(),
    attributes: applicabilityAttributesInputSchema.optional(),
  })
  .refine((v) => Boolean(v.requisitionId) !== Boolean(v.attributes), {
    message: "Provide exactly one of requisitionId or attributes",
  });
export type PreviewResolvedConfigurationInput = z.input<
  typeof previewResolvedConfigurationInputSchema
>;

const applicabilityAttributeSchema = z.enum(APPLICABILITY_ATTRIBUTES);

export const previewSubjectSchema = z.object({
  legalEntityId: z.string().nullable(),
  countryCode: z.string().nullable(),
  businessUnitId: z.string().nullable(),
  businessUnitLineage: z.array(z.string()),
  locationId: z.string().nullable(),
  jobFunctionId: z.string().nullable(),
  jobLevelRank: z.number().int().nullable(),
  jobProfileId: z.string().nullable(),
  employmentTypeKey: z.string().nullable(),
  requisitionTypeKey: z.string().nullable(),
});
export type PreviewSubject = z.infer<typeof previewSubjectSchema>;

export const previewKindResultSchema = z.object({
  kind: templateKindSchema,
  label: z.string(),
  consumed: z.boolean(),
  winner: z
    .object({
      assignmentId: z.string().uuid(),
      name: z.string(),
      templateId: z.string().uuid(),
      templateLabel: z.string().nullable(),
      matchedPredicates: z.array(applicabilityAttributeSchema),
      isDefault: z.boolean(),
      priority: z.number().int(),
    })
    .nullable(),
  ties: z.array(z.object({ assignmentId: z.string().uuid(), name: z.string() })),
  /** What applies when nothing matches (today's per-tenant behaviour). */
  fallback: z.string(),
  evaluated: z.array(
    z.object({
      assignmentId: z.string().uuid(),
      name: z.string(),
      matches: z.boolean(),
      matchedPredicates: z.array(applicabilityAttributeSchema),
      failedPredicates: z.array(applicabilityAttributeSchema),
      skippedReason: z.string().nullable(),
    }),
  ),
});
export type PreviewKindResult = z.infer<typeof previewKindResultSchema>;

export const previewResolvedConfigurationOutputSchema = z.object({
  requisitionId: z.string().uuid().nullable(),
  subject: previewSubjectSchema,
  kinds: z.array(previewKindResultSchema),
});
export type PreviewResolvedConfigurationOutput = z.infer<
  typeof previewResolvedConfigurationOutputSchema
>;

export function subjectToPreview(s: ApplicabilitySubject): PreviewSubject {
  return {
    legalEntityId: s.legal_entity_id,
    countryCode: s.country_code,
    businessUnitId: s.business_unit_id,
    businessUnitLineage: [...s.business_unit_lineage],
    locationId: s.location_id,
    jobFunctionId: s.job_function_id,
    jobLevelRank: s.job_level_rank,
    jobProfileId: s.job_profile_id,
    employmentTypeKey: s.employment_type_key,
    requisitionTypeKey: s.requisition_type_key,
  };
}

// ─────────────────────────── interview loops ───────────────────────────

/** The loop every tenant's legacy rounds belong to; the "no assignment" fallback. */
export const DEFAULT_INTERVIEW_LOOP_KEY = "default" as const;
export const interviewLoopKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,64}$/, "loop key must be lowercase snake_case (max 64)");

export const interviewLoopRowSchema = z.object({
  id: z.string().uuid(),
  loopKey: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  roundCount: z.number().int().nonnegative(),
});
export type InterviewLoopRow = z.infer<typeof interviewLoopRowSchema>;

export const listInterviewLoopsInputSchema = z.object({}).default({});
export const listInterviewLoopsOutputSchema = z.object({
  loops: z.array(interviewLoopRowSchema),
});
export type ListInterviewLoopsOutput = z.infer<typeof listInterviewLoopsOutputSchema>;

export const createInterviewLoopInputSchema = z.object({
  loopKey: interviewLoopKeySchema,
  label: z.string().trim().min(1).max(120),
});
export const updateInterviewLoopInputSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
  isActive: z.boolean(),
});
export const interviewLoopMutationOutputSchema = z.object({ row: interviewLoopRowSchema });

/** The "Test against a requisition" picker on /admin/applicability (latest first). */
export const listApplicabilityRequisitionsInputSchema = z
  .object({ search: z.string().trim().max(120).optional() })
  .default({});
export const listApplicabilityRequisitionsOutputSchema = z.object({
  requisitions: z.array(z.object({ id: z.string().uuid(), title: z.string(), status: z.string() })),
});
export type ListApplicabilityRequisitionsOutput = z.infer<
  typeof listApplicabilityRequisitionsOutputSchema
>;
