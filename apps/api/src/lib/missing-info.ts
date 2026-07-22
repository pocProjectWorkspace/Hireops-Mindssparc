/**
 * RECR-03 — Missing Info deterministic rule engine (PURE — no DB, no AI).
 *
 * The recruiter's "Missing Info Tracker" surfaces candidate data fields that
 * are absent, honestly. Two columns are DETERMINISTIC and computed here:
 *
 *   - Required vs Optional  — a fixed per-field policy (the field registry).
 *   - Blocks Advance to <stage>  — the real pipeline stage-gate a missing
 *     REQUIRED field blocks, or null when it blocks nothing. This is the honest
 *     replacement for the prototype's fabricated "Score Impact: Capped at 50"
 *     column: missing info is flagged, but a HARD gate is a deterministic
 *     stage-gate (backed by the knockout engine at the screening boundary),
 *     NEVER a magic score cap. There is deliberately no score-penalty output on
 *     this contract at all.
 *
 * This module is the sibling of comp-rules.ts / req-health.ts — a pure verdict
 * engine the router calls with a plain presence map (computed from the
 * application + parsed resume) and unit-tested directly (missing-info.test.ts).
 */

import type { ApplicationStage } from "@hireops/db";
import type { MissingInfoRequiredness } from "@hireops/api-types";

/** The canonical field keys the tracker understands. */
export const MISSING_INFO_FIELD_KEYS = [
  "expected_salary",
  "notice_period",
  "availability_date",
  "work_authorization",
  "current_location",
  "skills_confirmation",
  "education_year",
] as const;
export type MissingInfoFieldKey = (typeof MISSING_INFO_FIELD_KEYS)[number];

export interface MissingInfoFieldDef {
  key: MissingInfoFieldKey;
  label: string;
  requiredness: MissingInfoRequiredness;
  /**
   * The pipeline stage a candidate CANNOT advance to while this field is
   * missing, or null when the field gates nothing. `tech_interview` fields are
   * eligibility/logistics gates enforced by requisition knockouts at the
   * screening boundary; `offer_drafted` fields are offer-desk prerequisites
   * (you cannot sensibly draft an offer without the ask / join date). These are
   * deterministic policy gates — not a probabilistic penalty.
   */
  blocksAdvanceStage: ApplicationStage | null;
  /** Human description of where the value is read from (for docs / prompts). */
  source: string;
}

/**
 * The field registry. ORDER is the tracker's canonical display order. Editing
 * this table is the ONLY place requiredness / gating policy lives.
 */
export const MISSING_INFO_FIELDS: readonly MissingInfoFieldDef[] = [
  {
    key: "expected_salary",
    label: "Expected Salary",
    requiredness: "required",
    blocksAdvanceStage: "offer_drafted",
    source: "applications.expected_salary_inr_paise",
  },
  {
    key: "notice_period",
    label: "Notice Period",
    requiredness: "required",
    blocksAdvanceStage: "offer_drafted",
    source: "parsed_skills.notice_period_days",
  },
  {
    key: "availability_date",
    label: "Availability Date",
    requiredness: "required",
    blocksAdvanceStage: "offer_drafted",
    source: "parsed_skills.availability_date",
  },
  {
    key: "work_authorization",
    label: "Visa Status",
    requiredness: "required",
    blocksAdvanceStage: "tech_interview",
    source: "parsed_skills.work_authorization / personal.work_authorization",
  },
  {
    key: "current_location",
    label: "Current Location",
    requiredness: "required",
    blocksAdvanceStage: "tech_interview",
    source: "persons.location_country / parsed_skills.personal.location_country",
  },
  {
    key: "skills_confirmation",
    label: "Skills Confirmation",
    requiredness: "required",
    blocksAdvanceStage: "tech_interview",
    source: "parsed_skills.skills (non-empty)",
  },
  {
    key: "education_year",
    label: "Education Year",
    requiredness: "optional",
    blocksAdvanceStage: null,
    source: "parsed_skills.education[].year",
  },
] as const;

const FIELD_BY_KEY: Record<MissingInfoFieldKey, MissingInfoFieldDef> = Object.fromEntries(
  MISSING_INFO_FIELDS.map((f) => [f.key, f]),
) as Record<MissingInfoFieldKey, MissingInfoFieldDef>;

/** Minimal stage labels for the "Blocks advance to <stage>" line. Pure — the
 * router owns the fuller STAGE_LABELS map; the ones we gate on are covered. */
const STAGE_LABEL: Partial<Record<ApplicationStage, string>> = {
  recruiter_review: "Recruiter review",
  shortlisted: "Shortlist",
  tech_interview: "Technical interview",
  hr_round: "HR round",
  offer_drafted: "Offer",
  offer_accepted: "Offer accepted",
};

export function stageLabel(stage: ApplicationStage): string {
  return STAGE_LABEL[stage] ?? stage.replace(/_/g, " ");
}

/** A def's deterministic "Blocks advance to <stage>" label, or null. Works off a
 * field DEF (not the constant), so it honours an effective/tenant-overridden gate. */
export function blocksAdvanceLabelForDef(def: MissingInfoFieldDef): string | null {
  if (def.blocksAdvanceStage === null) return null;
  return `Blocks advance to ${stageLabel(def.blocksAdvanceStage)}`;
}

/** A field's deterministic "Blocks advance to <stage>" label, or null. Reads the
 * code-owned default catalog — for the effective (tenant-policy) label use
 * blocksAdvanceLabelForDef with an effective def. */
export function blocksAdvanceLabelFor(key: MissingInfoFieldKey): string | null {
  const def = FIELD_BY_KEY[key];
  if (!def) return null;
  return blocksAdvanceLabelForDef(def);
}

export function fieldDef(key: MissingInfoFieldKey): MissingInfoFieldDef | undefined {
  return FIELD_BY_KEY[key];
}

/**
 * A tenant's override for ONE catalog field (T2.1 / G05). The router loads these
 * from candidate_field_policy and merges them over the code default catalog. Only
 * the seven known keys are representable; `blocksAdvanceStage: null` = tracked-only.
 */
export interface MissingInfoPolicyOverride {
  fieldKey: MissingInfoFieldKey;
  requiredness: MissingInfoRequiredness;
  blocksAdvanceStage: ApplicationStage | null;
}

/**
 * Merge a tenant's policy overrides over the code default catalog and return the
 * EFFECTIVE field defs (same order as MISSING_INFO_FIELDS). A field with no
 * override keeps its code default byte-identically; with no overrides at all this
 * returns the constant itself (referential identity), so callers without a policy
 * are unchanged. Pure: no I/O.
 */
export function effectiveMissingInfoFields(
  overrides: readonly MissingInfoPolicyOverride[] = [],
): readonly MissingInfoFieldDef[] {
  if (overrides.length === 0) return MISSING_INFO_FIELDS;
  const byKey = new Map(overrides.map((o) => [o.fieldKey, o]));
  return MISSING_INFO_FIELDS.map((def) => {
    const o = byKey.get(def.key);
    if (!o) return def;
    return { ...def, requiredness: o.requiredness, blocksAdvanceStage: o.blocksAdvanceStage };
  });
}

/** Look up a def by key in a (possibly effective) field-def array. */
export function fieldDefFrom(
  fields: readonly MissingInfoFieldDef[],
  key: MissingInfoFieldKey,
): MissingInfoFieldDef | undefined {
  return fields.find((f) => f.key === key);
}

export function isMissingInfoFieldKey(key: string): key is MissingInfoFieldKey {
  return key in FIELD_BY_KEY;
}

/** `true` = present on the application/resume, `false` = missing. */
export type FieldPresence = Partial<Record<MissingInfoFieldKey, boolean>>;

/** One computed missing-field verdict. NO score/cap field — by design. */
export interface MissingFieldVerdict {
  fieldKey: MissingInfoFieldKey;
  fieldLabel: string;
  requiredness: MissingInfoRequiredness;
  blocksAdvanceStage: ApplicationStage | null;
  blocksAdvanceLabel: string | null;
}

/**
 * Given a presence map, return a verdict for every field that is MISSING
 * (presence explicitly false). A field absent from the map is treated as
 * "unknown" and skipped — the caller decides presence; this engine only
 * classifies. Order follows the registry order. Pure: no I/O, no AI.
 *
 * `fields` defaults to the code-owned catalog, so callers without a tenant policy
 * are byte-identical to before. The router passes the EFFECTIVE defs
 * (effectiveMissingInfoFields) so the tracker display honours the tenant's policy.
 */
export function computeMissingInfo(
  presence: FieldPresence,
  fields: readonly MissingInfoFieldDef[] = MISSING_INFO_FIELDS,
): MissingFieldVerdict[] {
  const out: MissingFieldVerdict[] = [];
  for (const def of fields) {
    if (presence[def.key] !== false) continue;
    out.push({
      fieldKey: def.key,
      fieldLabel: def.label,
      requiredness: def.requiredness,
      blocksAdvanceStage: def.blocksAdvanceStage,
      blocksAdvanceLabel: blocksAdvanceLabelForDef(def),
    });
  }
  return out;
}
