/**
 * C2-F12 — the applicability resolver's DB side (Plan A §15 P3).
 *
 * The pure core (predicate evaluation + ranking) lives in
 * @hireops/api-types `applicability.ts`; this module loads what it needs:
 *
 *   - loadRequisitionAttributes(db, tenantId, requisitionId) — the subject,
 *     loaded ONCE per requisition (requisition columns, falling back to its
 *     position's, plus the BU lineage / entity / country / level rank);
 *   - buildSubjectFromAttributes — the same derivation for a what-if preview;
 *   - loadTemplateTargets — every assignable template per kind, with the
 *     reason (if any) it can't be used right now;
 *   - resolveTemplate(db, tenantId, kind, subject) — the winning assignment or
 *     null (the caller then keeps today's per-tenant behaviour).
 *
 * BU descendants: a condition on business unit B matches a requisition raised
 * on B or on any unit below it. The subject carries the unit's lineage (itself
 * + every ancestor, cycle-safe — businessUnitLineage), which is the same set
 * relation as the reports' recursive subtree helper (lib/reports/bu-tree.ts)
 * read from the other end, so one query serves every assignment.
 *
 * Every query runs on the caller's RLS-bound tx AND carries an explicit
 * tenant predicate.
 */

import { sql as dsql } from "drizzle-orm";
import type { TenantBoundDb } from "@hireops/db";
import {
  DEFAULT_INTERVIEW_LOOP_KEY,
  EMPTY_APPLICABILITY_SUBJECT,
  businessUnitLineage,
  rankAssignments,
  type ApplicabilityAttributesInput,
  type ApplicabilityResolution,
  type ApplicabilitySubject,
  type AssignmentCandidate,
  type RankResult,
  type TemplateKind,
  type TemplateTargetOption,
} from "@hireops/api-types";

export type ApplicabilityDb = TenantBoundDb;

function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

// ─────────────────────────── subject ───────────────────────────

interface BuRow {
  id: string;
  parent_id: string | null;
  legal_entity_id: string | null;
}

async function loadBusinessUnits(db: ApplicabilityDb, tenantId: string): Promise<BuRow[]> {
  return asRows<BuRow>(
    await db.execute(dsql`
      SELECT id::text AS id, parent_business_unit_id::text AS parent_id,
             legal_entity_id::text AS legal_entity_id
        FROM public.business_units WHERE tenant_id = ${tenantId}::uuid
    `),
  );
}

async function entityCountry(
  db: ApplicabilityDb,
  tenantId: string,
  entityId: string | null,
): Promise<string | null> {
  if (!entityId) return null;
  const [r] = asRows<{ country_code: string }>(
    await db.execute(dsql`
      SELECT country_code FROM public.legal_entities
       WHERE tenant_id = ${tenantId}::uuid AND id = ${entityId}::uuid
    `),
  );
  return r?.country_code ?? null;
}

/**
 * Complete a partial subject: BU lineage; legal entity = the nearest entity
 * up the BU lineage, else the location's; country = the location's, else the
 * entity's. Explicit values (preview input) are kept.
 */
async function completeSubject(
  db: ApplicabilityDb,
  tenantId: string,
  base: ApplicabilitySubject,
  locationEntityId: string | null,
  locationCountry: string | null,
): Promise<ApplicabilitySubject> {
  const units = base.business_unit_id ? await loadBusinessUnits(db, tenantId) : [];
  const lineage = businessUnitLineage(
    units.map((u) => ({ id: u.id, parentId: u.parent_id })),
    base.business_unit_id,
  );
  const byId = new Map(units.map((u) => [u.id, u] as const));
  const buEntity = lineage.map((id) => byId.get(id)?.legal_entity_id ?? null).find(Boolean) ?? null;
  const legalEntityId = base.legal_entity_id ?? buEntity ?? locationEntityId;
  const country =
    base.country_code ?? locationCountry ?? (await entityCountry(db, tenantId, legalEntityId));
  return {
    ...base,
    business_unit_lineage: lineage,
    legal_entity_id: legalEntityId,
    country_code: country ? country.toUpperCase() : null,
  };
}

/**
 * The requisition's attributes. Structured columns on the requisition win;
 * the position's (location / function / level / profile) fill the gaps; the
 * business unit is the position's. null when the requisition isn't visible.
 */
export async function loadRequisitionAttributes(
  db: ApplicabilityDb,
  tenantId: string,
  requisitionId: string,
): Promise<ApplicabilitySubject | null> {
  const [r] = asRows<{
    business_unit_id: string | null;
    location_id: string | null;
    job_function_id: string | null;
    job_level_id: string | null;
    job_profile_id: string | null;
    employment_type_key: string | null;
    requisition_type_key: string | null;
    level_rank: number | null;
    loc_country: string | null;
    loc_entity: string | null;
  }>(
    await db.execute(dsql`
      SELECT p.business_unit_id::text AS business_unit_id,
             COALESCE(r.location_id, p.location_id)::text AS location_id,
             COALESCE(r.job_function_id, p.job_function_id)::text AS job_function_id,
             COALESCE(r.job_level_id, p.job_level_id)::text AS job_level_id,
             COALESCE(r.job_profile_id, p.job_profile_id)::text AS job_profile_id,
             r.employment_type_key, r.requisition_type_key,
             lv.rank AS level_rank, loc.country_code AS loc_country,
             loc.legal_entity_id::text AS loc_entity
        FROM public.requisitions r
        JOIN public.positions p ON p.id = r.position_id AND p.tenant_id = r.tenant_id
        LEFT JOIN public.job_levels lv
          ON lv.id = COALESCE(r.job_level_id, p.job_level_id) AND lv.tenant_id = r.tenant_id
        LEFT JOIN public.locations loc
          ON loc.id = COALESCE(r.location_id, p.location_id) AND loc.tenant_id = r.tenant_id
       WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ${requisitionId}::uuid
    `),
  );
  if (!r) return null;
  return completeSubject(
    db,
    tenantId,
    {
      ...EMPTY_APPLICABILITY_SUBJECT,
      business_unit_id: r.business_unit_id,
      location_id: r.location_id,
      job_function_id: r.job_function_id,
      job_level_rank: r.level_rank === null ? null : Number(r.level_rank),
      job_profile_id: r.job_profile_id,
      employment_type_key: r.employment_type_key,
      requisition_type_key: r.requisition_type_key,
    },
    r.loc_entity,
    r.loc_country,
  );
}

/** The same derivation for a what-if (no requisition): ids are looked up in-tenant. */
export async function buildSubjectFromAttributes(
  db: ApplicabilityDb,
  tenantId: string,
  a: ApplicabilityAttributesInput,
): Promise<ApplicabilitySubject> {
  let rank: number | null = null;
  if (a.jobLevelId) {
    const [lv] = asRows<{ rank: number }>(
      await db.execute(dsql`
        SELECT rank FROM public.job_levels
         WHERE tenant_id = ${tenantId}::uuid AND id = ${a.jobLevelId}::uuid
      `),
    );
    rank = lv ? Number(lv.rank) : null;
  }
  let locEntity: string | null = null;
  let locCountry: string | null = null;
  if (a.locationId) {
    const [loc] = asRows<{ country_code: string; legal_entity_id: string | null }>(
      await db.execute(dsql`
        SELECT country_code, legal_entity_id::text AS legal_entity_id FROM public.locations
         WHERE tenant_id = ${tenantId}::uuid AND id = ${a.locationId}::uuid
      `),
    );
    locEntity = loc?.legal_entity_id ?? null;
    locCountry = loc?.country_code ?? null;
  }
  return completeSubject(
    db,
    tenantId,
    {
      ...EMPTY_APPLICABILITY_SUBJECT,
      legal_entity_id: a.legalEntityId ?? null,
      country_code: a.countryCode ? a.countryCode.toUpperCase() : null,
      business_unit_id: a.businessUnitId ?? null,
      location_id: a.locationId ?? null,
      job_function_id: a.jobFunctionId ?? null,
      job_level_rank: rank,
      job_profile_id: a.jobProfileId ?? null,
      employment_type_key: a.employmentTypeKey ?? null,
      requisition_type_key: a.requisitionTypeKey ?? null,
    },
    locEntity,
    locCountry,
  );
}

// ─────────────────────────── assignments + targets ───────────────────────────

export async function loadAssignments(
  db: ApplicabilityDb,
  tenantId: string,
  kind?: TemplateKind,
): Promise<(AssignmentCandidate & { updatedAt: Date | string })[]> {
  const rows = asRows<{
    id: string;
    template_kind: string;
    name: string;
    template_id: string;
    priority: number;
    is_active: boolean;
    conditions: unknown;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    await db.execute(dsql`
      SELECT id::text AS id, template_kind, name, template_id::text AS template_id, priority,
             is_active, conditions, created_at, updated_at
        FROM public.template_assignments
       WHERE tenant_id = ${tenantId}::uuid
         ${kind ? dsql`AND template_kind = ${kind}` : dsql``}
       ORDER BY template_kind, priority DESC, name
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    templateKind: r.template_kind as TemplateKind,
    templateId: r.template_id,
    priority: Number(r.priority),
    isActive: r.is_active,
    conditions: r.conditions,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export interface TemplateTarget extends TemplateTargetOption {
  /** Why it can't be chosen right now (inactive / empty), or null. */
  problem: string | null;
}

/**
 * Every assignable template, per CONSUMED kind. Kinds without a consumer yet
 * have no target table, so nothing is assignable for them.
 */
export async function loadTemplateTargets(
  db: ApplicabilityDb,
  tenantId: string,
): Promise<TemplateTarget[]> {
  await ensureDefaultInterviewLoop(db, tenantId);
  const loops = asRows<{
    id: string;
    loop_key: string;
    label: string;
    is_active: boolean;
    rounds: number;
  }>(
    await db.execute(dsql`
      SELECT l.id::text AS id, l.loop_key, l.label, l.is_active,
             (SELECT count(*)::int FROM public.tenant_interview_round_template t
               WHERE t.tenant_id = l.tenant_id AND t.loop_key = l.loop_key) AS rounds
        FROM public.interview_loops l
       WHERE l.tenant_id = ${tenantId}::uuid
       ORDER BY (l.loop_key = ${DEFAULT_INTERVIEW_LOOP_KEY}) DESC, l.label
    `),
  );
  const scorecards = asRows<{
    id: string;
    scorecard_key: string;
    label: string;
    criteria: unknown;
  }>(
    await db.execute(dsql`
      SELECT id::text AS id, scorecard_key, label, criteria FROM public.tenant_scorecard_template
       WHERE tenant_id = ${tenantId}::uuid ORDER BY label
    `),
  );
  return [
    ...loops.map((l) => ({
      kind: "interview_loop" as const,
      id: l.id,
      key: l.loop_key,
      label: l.label,
      isActive: l.is_active,
      problem: !l.is_active
        ? "the loop is inactive"
        : Number(l.rounds) === 0
          ? "the loop has no rounds"
          : null,
    })),
    ...scorecards.map((s) => ({
      kind: "scorecard" as const,
      id: s.id,
      key: s.scorecard_key,
      label: s.label,
      isActive: true,
      problem:
        Array.isArray(s.criteria) && s.criteria.length > 0 ? null : "the scorecard has no criteria",
    })),
  ];
}

function targetCheck(
  targets: readonly TemplateTarget[],
  kind: TemplateKind,
): (templateId: string) => string | null {
  const byId = new Map(targets.filter((t) => t.kind === kind).map((t) => [t.id, t] as const));
  return (templateId) => {
    const t = byId.get(templateId);
    if (!t) return "the target template no longer exists";
    return t.problem;
  };
}

/** Rank every assignment of `kind` (the preview needs the full evaluation). */
export async function evaluateKind(
  db: ApplicabilityDb,
  tenantId: string,
  kind: TemplateKind,
  subject: ApplicabilitySubject,
  preloaded?: { targets?: TemplateTarget[]; assignments?: AssignmentCandidate[] },
): Promise<RankResult> {
  const targets = preloaded?.targets ?? (await loadTemplateTargets(db, tenantId));
  const assignments = preloaded?.assignments ?? (await loadAssignments(db, tenantId, kind));
  return rankAssignments(kind, assignments, subject, targetCheck(targets, kind));
}

/**
 * THE resolver. The winning assignment for `kind`, or null — the caller then
 * keeps today's per-tenant default (nothing changes for a tenant with no
 * assignments).
 */
export async function resolveTemplate(
  db: ApplicabilityDb,
  tenantId: string,
  kind: TemplateKind,
  subject: ApplicabilitySubject,
): Promise<(ApplicabilityResolution & { templateKey: string | null }) | null> {
  const targets = await loadTemplateTargets(db, tenantId);
  const { winner } = await evaluateKind(db, tenantId, kind, subject, { targets });
  if (!winner) return null;
  const t = targets.find((x) => x.kind === kind && x.id === winner.templateId);
  return { ...winner, templateKey: t?.key ?? null };
}

// ─────────────────────────── interview loops ───────────────────────────

/** Idempotently create the tenant's 'default' loop row (0136 backfills existing tenants). */
export async function ensureDefaultInterviewLoop(
  db: ApplicabilityDb,
  tenantId: string,
): Promise<void> {
  await db.execute(dsql`
    INSERT INTO public.interview_loops (tenant_id, loop_key, label)
    VALUES (${tenantId}::uuid, ${DEFAULT_INTERVIEW_LOOP_KEY}, 'Default loop')
    ON CONFLICT (tenant_id, loop_key) DO NOTHING
  `);
}

export interface LoopChoice {
  loopKey: string;
  assignmentId: string | null;
  matchedPredicates: string[];
  subject: ApplicabilitySubject | null;
}

/**
 * Which loop seeds this requisition's plan: the applicability winner, else
 * the 'default' loop (today's behaviour).
 */
export async function chooseInterviewLoop(
  db: ApplicabilityDb,
  tenantId: string,
  requisitionId: string,
): Promise<LoopChoice> {
  const subject = await loadRequisitionAttributes(db, tenantId, requisitionId);
  if (subject) {
    const win = await resolveTemplate(db, tenantId, "interview_loop", subject);
    if (win?.templateKey) {
      return {
        loopKey: win.templateKey,
        assignmentId: win.assignmentId,
        matchedPredicates: win.matchedPredicates,
        subject,
      };
    }
  }
  return {
    loopKey: DEFAULT_INTERVIEW_LOOP_KEY,
    assignmentId: null,
    matchedPredicates: [],
    subject,
  };
}

/**
 * The scorecard key applicability gives this subject (for a round with no
 * pinned scorecard), or null → the caller's fallback.
 */
export async function resolveScorecardKey(
  db: ApplicabilityDb,
  tenantId: string,
  subject: ApplicabilitySubject | null,
): Promise<{ scorecardKey: string; assignmentId: string } | null> {
  if (!subject) return null;
  const win = await resolveTemplate(db, tenantId, "scorecard", subject);
  return win?.templateKey
    ? { scorecardKey: win.templateKey, assignmentId: win.assignmentId }
    : null;
}
