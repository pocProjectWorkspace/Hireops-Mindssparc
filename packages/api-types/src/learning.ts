/**
 * L&D in onboarding (LD-1A) contracts. Pure zod — the tRPC surface (`apps/api`),
 * the admin `/admin/learning` page and the candidate learning list (both LD-1B)
 * validate against these single definitions.
 *
 * THE MODEL — HireOps ORCHESTRATES learning, it does not author or host it:
 *
 *   1. The org CURATES a catalogue of pointers (`learning_resources`) — a
 *      Workday Learning / LinkedIn Learning / Cornerstone deep link, a
 *      SharePoint or Drive doc, an unlisted video, a Confluence page. `url` is
 *      the payload; there is no upload (that would be authoring).
 *   2. It optionally bundles them into TRACKS (`learning_tracks`) — one
 *      'organisation' induction layer, one 'role' layer bound to a position or
 *      a role family.
 *   3. A recruiter PUSHES a track and/or loose resources onto ONE new hire's
 *      onboarding case (`assignLearningToCase`). The push is an explicit act of
 *      intent, not a rule that fires on its own.
 *
 * A per-hire assignment is NOT a new table: it is an ordinary `onboarding_tasks`
 * row whose `metadata` points at the resource (exactly how document_collection
 * tasks point at a document type). So case rollup, overdue logic, the internal
 * case-detail surface and the audit trail all apply for free.
 *
 * HONEST LIMITATION: completion is SELF-ATTESTED. Without an LMS callback we
 * cannot verify the hire watched anything — `candidateUpdateLearningProgress` is
 * the hire's own claim. Do not let any surface imply verified completion.
 */

import { z } from "zod";

// ─────────────────────────── shared vocabularies ───────────────────────────

/** Where the material actually lives. Mirrors the learning_resources.provider
 * CHECK constraint exactly. */
export const learningProviderSchema = z.enum([
  "workday_learning",
  "linkedin_learning",
  "cornerstone",
  "internal_doc",
  "video",
  "link",
  "other",
]);
export type LearningProvider = z.infer<typeof learningProviderSchema>;

/** A track's layer. Mirrors the learning_tracks.layer CHECK constraint. The
 * third layer of the client's ask (the individual's capability gaps) is NOT a
 * track — it is derived per hire and lands in LD-2. */
export const learningTrackLayerSchema = z.enum(["organisation", "role"]);
export type LearningTrackLayer = z.infer<typeof learningTrackLayerSchema>;

/** The layer tag written onto a pushed task's metadata. Adds 'individual' — a
 * loose resource pushed at one hire has no track behind it, which IS the
 * per-individual layer in its manual form. */
export const learningAssignmentLayerSchema = z.enum(["organisation", "role", "individual"]);
export type LearningAssignmentLayer = z.infer<typeof learningAssignmentLayerSchema>;

const MAX_URL_LEN = 2000;

// ═══════════════════════ (A) the resource catalogue ═══════════════════════

/** One catalogue row as the admin surface renders it. */
export const learningResourceRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  provider: learningProviderSchema,
  url: z.string(),
  externalRef: z.string().nullable(),
  estimatedMinutes: z.number().int().nullable(),
  isArchived: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});
export type LearningResourceRow = z.infer<typeof learningResourceRowSchema>;

export const listLearningResourcesInputSchema = z
  .object({
    /** Include archived resources (the admin surface shows them; the pickers
     * do not). Defaults to active-only. */
    includeArchived: z.boolean().optional(),
  })
  .default({});
export type ListLearningResourcesInput = z.infer<typeof listLearningResourcesInputSchema>;

export const listLearningResourcesOutputSchema = z.object({
  rows: z.array(learningResourceRowSchema),
});
export type ListLearningResourcesOutput = z.infer<typeof listLearningResourcesOutputSchema>;

/** Create (no id) or update (id) one catalogue row. `title` is the idempotent
 * key — unique(tenant_id, title) — so a re-created row with the same title
 * surfaces a clean BAD_REQUEST rather than a duplicate. */
export const upsertLearningResourceInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  provider: learningProviderSchema,
  url: z.string().trim().url().max(MAX_URL_LEN),
  externalRef: z.string().trim().max(200).nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type UpsertLearningResourceInput = z.infer<typeof upsertLearningResourceInputSchema>;

export const upsertLearningResourceOutputSchema = z.object({
  row: learningResourceRowSchema,
});
export type UpsertLearningResourceOutput = z.infer<typeof upsertLearningResourceOutputSchema>;

/** Archive / restore. Resources are archived, never deleted: track items FK
 * them, and tasks already pushed onto a hire's case must keep resolving. */
export const archiveLearningResourceInputSchema = z.object({
  id: z.string().uuid(),
  archived: z.boolean(),
});
export type ArchiveLearningResourceInput = z.infer<typeof archiveLearningResourceInputSchema>;

export const archiveLearningResourceOutputSchema = z.object({
  row: learningResourceRowSchema,
});
export type ArchiveLearningResourceOutput = z.infer<typeof archiveLearningResourceOutputSchema>;

// ═══════════════════════════ (B) the tracks ═══════════════════════════

/** One item inside a track, denormalised with the bits the editor renders. */
export const learningTrackItemRowSchema = z.object({
  resourceId: z.string().uuid(),
  resourceTitle: z.string(),
  resourceProvider: learningProviderSchema,
  resourceIsArchived: z.boolean(),
  sortOrder: z.number().int(),
  isRequired: z.boolean(),
  /** Days after the case's expected start date. Null = no due date. */
  dueOffsetDays: z.number().int().nullable(),
});
export type LearningTrackItemRow = z.infer<typeof learningTrackItemRowSchema>;

export const learningTrackRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  layer: learningTrackLayerSchema,
  businessUnitId: z.string().uuid().nullable(),
  positionId: z.string().uuid().nullable(),
  roleFamily: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  items: z.array(learningTrackItemRowSchema),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});
export type LearningTrackRow = z.infer<typeof learningTrackRowSchema>;

export const listLearningTracksInputSchema = z
  .object({
    layer: learningTrackLayerSchema.optional(),
    /** Include inactive tracks (the admin surface shows them). */
    includeInactive: z.boolean().optional(),
  })
  .default({});
export type ListLearningTracksInput = z.infer<typeof listLearningTracksInputSchema>;

export const listLearningTracksOutputSchema = z.object({
  rows: z.array(learningTrackRowSchema),
});
export type ListLearningTracksOutput = z.infer<typeof listLearningTracksOutputSchema>;

/**
 * Create (no id) or update (id) a track's HEADER. Items are set separately by
 * setLearningTrackItems, so an edit to the header never disturbs the contents.
 *
 * The binding invariant is enforced here AND by the learning_tracks_binding_check
 * DB constraint: a 'role' track carries EXACTLY ONE of positionId / roleFamily;
 * an 'organisation' track carries neither (its optional businessUnitId scopes
 * the induction to one BU, null = every hire).
 */
export const upsertLearningTrackInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    layer: learningTrackLayerSchema,
    businessUnitId: z.string().uuid().nullable().optional(),
    positionId: z.string().uuid().nullable().optional(),
    roleFamily: z.string().trim().min(1).max(120).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .superRefine((val, ctx) => {
    const hasPosition = val.positionId != null;
    const hasFamily = val.roleFamily != null && val.roleFamily.length > 0;
    if (val.layer === "role" && hasPosition === hasFamily) {
      ctx.addIssue({
        code: "custom",
        message: "A role track must bind to exactly one of positionId or roleFamily.",
        path: ["positionId"],
      });
    }
    if (val.layer === "organisation" && (hasPosition || hasFamily)) {
      ctx.addIssue({
        code: "custom",
        message: "An organisation track carries neither positionId nor roleFamily.",
        path: ["layer"],
      });
    }
  });
export type UpsertLearningTrackInput = z.infer<typeof upsertLearningTrackInputSchema>;

export const upsertLearningTrackOutputSchema = z.object({
  row: learningTrackRowSchema,
});
export type UpsertLearningTrackOutput = z.infer<typeof upsertLearningTrackOutputSchema>;

/** Replace-set a track's whole ordered item list (the round-template shape):
 * the array order IS the sort order, and an empty array clears the track. */
export const setLearningTrackItemsInputSchema = z.object({
  trackId: z.string().uuid(),
  items: z
    .array(
      z.object({
        resourceId: z.string().uuid(),
        isRequired: z.boolean().optional(),
        dueOffsetDays: z.number().int().min(0).max(3650).nullable().optional(),
      }),
    )
    .max(50),
});
export type SetLearningTrackItemsInput = z.infer<typeof setLearningTrackItemsInputSchema>;

export const setLearningTrackItemsOutputSchema = z.object({
  row: learningTrackRowSchema,
});
export type SetLearningTrackItemsOutput = z.infer<typeof setLearningTrackItemsOutputSchema>;

// ═════════════════════ (C) the push onto a hire's case ═════════════════════

/**
 * Push a track's items and/or loose resources onto ONE onboarding case.
 *
 * Allowed at ANY case status — a `pre_boarding` hire who has not yet activated
 * a portal account still gets the notification and finds the items waiting
 * (resolved 3 Aug: the recruiter owns the timing).
 *
 * IDEMPOTENT on (case_id, metadata->>'learningResourceId'): re-pushing adds only
 * what is new and NEVER resets progress on what is already there.
 */
export const assignLearningToCaseInputSchema = z
  .object({
    caseId: z.string().uuid(),
    /** Push a whole curated bundle. */
    trackId: z.string().uuid().optional(),
    /** …and/or loose catalogue rows, tagged as the 'individual' layer. */
    resourceIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.trackId && (val.resourceIds ?? []).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Give a trackId, at least one resourceId, or both.",
        path: ["resourceIds"],
      });
    }
  });
export type AssignLearningToCaseInput = z.infer<typeof assignLearningToCaseInputSchema>;

export const assignLearningToCaseOutputSchema = z.object({
  caseId: z.string().uuid(),
  /** Tasks newly created by this push. */
  assigned: z.number().int().nonnegative(),
  /** Resources this case already had — left untouched, progress preserved. */
  skipped: z.number().int().nonnegative(),
  /** Candidate notifications enqueued (one per newly-assigned resource). */
  notified: z.number().int().nonnegative(),
  /** The onboarding_tasks ids created by this push. */
  taskIds: z.array(z.string().uuid()),
});
export type AssignLearningToCaseOutput = z.infer<typeof assignLearningToCaseOutputSchema>;

// ═════════════════════════ (D) the hire's own view ═════════════════════════

/**
 * One learning item as the hire sees it — the onboarding task joined back to
 * the catalogue row its metadata points at. `provider` / `url` fall back to the
 * values snapshot onto the task metadata at push time, so an item still renders
 * if the catalogue row was archived afterwards.
 */
export const candidateLearningItemSchema = z.object({
  taskId: z.string().uuid(),
  /** The onboarding task status: pending | in_progress | completed | … */
  status: z.string(),
  layer: learningAssignmentLayerSchema,
  title: z.string(),
  description: z.string().nullable(),
  provider: z.string().nullable(),
  url: z.string().nullable(),
  estimatedMinutes: z.number().int().nullable(),
  isRequired: z.boolean(),
  dueAt: z.string().nullable(), // ISO
  completedAt: z.string().nullable(), // ISO
});
export type CandidateLearningItem = z.infer<typeof candidateLearningItemSchema>;

/**
 * The hire's self-attested progress flip on ONE of their own learning tasks.
 * Forward-only: pending → in_progress → completed. Nothing here verifies the
 * hire actually consumed the material (see the honest limitation above).
 */
export const candidateUpdateLearningProgressInputSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["in_progress", "completed"]),
});
export type CandidateUpdateLearningProgressInput = z.infer<
  typeof candidateUpdateLearningProgressInputSchema
>;

export const candidateUpdateLearningProgressOutputSchema = z.object({
  taskId: z.string().uuid(),
  status: z.string(),
  completedAt: z.string().nullable(), // ISO
});
export type CandidateUpdateLearningProgressOutput = z.infer<
  typeof candidateUpdateLearningProgressOutputSchema
>;

// ══════════════ (E) layer 3 — the per-individual upskilling map (LD-2A) ══════════════

/**
 * THE ASYMMETRY, stated plainly: layers 1 and 2 above are curated BUNDLES a
 * person authors once. Layer 3 — this hire's own capability gaps — is
 * per-individual by definition and cannot be pre-authored. So the org does not
 * curate the plan; it curates WHICH RESOURCE CLOSES WHICH SKILL
 * (`learning_skill_map`), and the system derives the plan from the JD-vs-hire
 * skill comparison HireOps already ran at application time.
 *
 * What comes back is SUGGESTIONS, never assignments. `getSuggestedLearningForCase`
 * writes nothing: the recruiter pushes what they agree with through the existing
 * `assignLearningToCase`, so there stays exactly ONE way learning reaches a hire.
 * Every suggestion carries the skill it closes so the surface can explain itself.
 */

/** One (skill → resource) mapping, denormalised with the catalogue bits the
 * admin editor renders. */
export const learningSkillMapRowSchema = z.object({
  id: z.string().uuid(),
  skillName: z.string(),
  resourceId: z.string().uuid(),
  resourceTitle: z.string(),
  resourceProvider: learningProviderSchema,
  /** Archived resources stay MAPPED (un-archiving restores the mapping) but are
   * never suggested. The editor shows the flag so the retirement is visible. */
  resourceIsArchived: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});
export type LearningSkillMapRow = z.infer<typeof learningSkillMapRowSchema>;

export const listLearningSkillMapInputSchema = z
  .object({
    /** Narrow to one skill (matched trimmed + case-insensitively, the same
     * normalisation the suggestion path uses). */
    skillName: z.string().trim().min(1).max(200).optional(),
  })
  .default({});
export type ListLearningSkillMapInput = z.infer<typeof listLearningSkillMapInputSchema>;

export const listLearningSkillMapOutputSchema = z.object({
  rows: z.array(learningSkillMapRowSchema),
});
export type ListLearningSkillMapOutput = z.infer<typeof listLearningSkillMapOutputSchema>;

/**
 * Create (no id) or update (id) one mapping. `skill_name` is free text on
 * purpose — it has to line up with the tenant's own `jd_skills.skill_name`
 * vocabulary, which is free text too. unique(tenant, skill_name, resource_id)
 * makes (skill, resource) the idempotent key, so a duplicate surfaces a clean
 * BAD_REQUEST rather than a second identical row.
 */
export const upsertLearningSkillMappingInputSchema = z.object({
  id: z.string().uuid().optional(),
  skillName: z.string().trim().min(1).max(200),
  resourceId: z.string().uuid(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type UpsertLearningSkillMappingInput = z.infer<typeof upsertLearningSkillMappingInputSchema>;

export const upsertLearningSkillMappingOutputSchema = z.object({
  row: learningSkillMapRowSchema,
});
export type UpsertLearningSkillMappingOutput = z.infer<
  typeof upsertLearningSkillMappingOutputSchema
>;

/** Unmap a resource from a skill. A HARD delete, unlike the catalogue: a
 * mapping is a curation opinion with nothing hanging off it — tasks already
 * pushed at a hire point at the RESOURCE, never at the mapping. */
export const deleteLearningSkillMappingInputSchema = z.object({
  id: z.string().uuid(),
});
export type DeleteLearningSkillMappingInput = z.infer<typeof deleteLearningSkillMappingInputSchema>;

export const deleteLearningSkillMappingOutputSchema = z.object({
  id: z.string().uuid(),
});
export type DeleteLearningSkillMappingOutput = z.infer<
  typeof deleteLearningSkillMappingOutputSchema
>;

/** One suggested resource, carrying the JD skill it closes. */
export const suggestedLearningItemSchema = z.object({
  resourceId: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  provider: learningProviderSchema,
  url: z.string(),
  estimatedMinutes: z.number().int().nullable(),
  /** The JD skill this closes, verbatim from `jd_skills` — the WHY the surface
   * shows next to the item. */
  skillName: z.string(),
  /** Whether that JD skill is a must-have. Must-have gaps rank first. */
  isRequiredSkill: z.boolean(),
});
export type SuggestedLearningItem = z.infer<typeof suggestedLearningItemSchema>;

/** One gap in the hire's profile against this JD. */
export const learningMissingSkillSchema = z.object({
  skillName: z.string(),
  isRequired: z.boolean(),
  /** true = the org has something to offer for this gap right now. false =
   * nothing is mapped to the skill, everything mapped is archived, or all of it
   * is already on this case — the first of which is the admin's cue to add a
   * mapping, and worth showing rather than hiding. */
  hasSuggestion: z.boolean(),
});
export type LearningMissingSkill = z.infer<typeof learningMissingSkillSchema>;

export const getSuggestedLearningForCaseInputSchema = z.object({
  caseId: z.string().uuid(),
  /** Cap on returned suggestions so a weak-profile hire is not buried. */
  limit: z.number().int().min(1).max(50).optional(),
});
export type GetSuggestedLearningForCaseInput = z.infer<
  typeof getSuggestedLearningForCaseInputSchema
>;

export const getSuggestedLearningForCaseOutputSchema = z.object({
  caseId: z.string().uuid(),
  /** Ranked: must-have gaps first, then the JD's own skill order, then the
   * mapping's sort order. Excludes archived resources and anything already
   * pushed onto this case. */
  suggestions: z.array(suggestedLearningItemSchema),
  missingSkills: z.array(learningMissingSkillSchema),
  /** How many skills the JD lists. 0 = nothing to compare against. */
  jdSkillCount: z.number().int().nonnegative(),
  /**
   * false when the hire's `parsed_skills` is null, empty or badly shaped. The
   * honest answer then is "no gaps identified" — empty lists — NOT "missing
   * everything", which is exactly the false 100%-gap wall the analytics seed
   * produced. The surface should say the CV was not parsed, not invent a plan.
   */
  hasParsedSkills: z.boolean(),
});
export type GetSuggestedLearningForCaseOutput = z.infer<
  typeof getSuggestedLearningForCaseOutputSchema
>;
