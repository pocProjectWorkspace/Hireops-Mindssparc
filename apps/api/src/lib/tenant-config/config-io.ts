/**
 * C1-F11 — read a tenant's CONFIGURATION into a portable document, and apply
 * a document (or a starter pack) back onto a tenant.
 *
 * WHAT IS CONFIGURATION. The allowlisted `tenants.settings` blocks (people
 * data scrubbed — see TENANT_SETTINGS_BLOCKS), locale, tenant lists, org +
 * job architecture, comp bands, interview loops + rounds + scorecards,
 * template assignments (applicability rules, by natural key — C2-F12), email
 * overrides, candidate field policy, sources, approval routing, panel-pool
 * STRUCTURE (never members), JD templates and — when the schema has them —
 * tenant document types. Never: people, memberships, candidates,
 * requisitions, applications, offers, integration credentials, encryption
 * keys, the starter-pack marker or the wizard state.
 *
 * ACCESS. Everything runs on the service-role pool with an explicit
 * `tenant_id = ${tenantId}` predicate on every statement: the tenant id comes
 * from the verified JWT (tenant admin) or the platform console (operator),
 * never from the document. `tenants.settings` has no authenticated write
 * policy, so one service-role transaction is the only way to make an import
 * atomic across settings and config tables. The transaction sets the
 * app.actor_* session vars, so the audit_record_change trigger on every
 * config table records who changed what (tenant audit).
 *
 * APPLY MODES. `replace` (import): each PRESENT section becomes the desired
 * state — adds, changes, removals (removal = deactivate / archive / end-date
 * / reset, see TENANT_CONFIG_REMOVAL_MODE). `additive` (starter packs): adds
 * only, so re-running provisioning never duplicates a row and never
 * overwrites a value an admin has changed since.
 */

import type { sql as poolSql } from "@hireops/db";
import {
  TENANT_CONFIG_FORMAT,
  TENANT_CONFIG_SCHEMA_VERSION,
  TENANT_SETTINGS_BLOCKS,
  configRecordKey,
  diffTenantConfig,
  parseInterviewRoundRecordKey,
  parseStoredConditions,
  TEMPLATE_KIND_META,
  type ConfigApplicabilityConditions,
  type TemplateKind,
  resolveTenantDefaultCountry,
  settingsBlockDef,
  type ConfigSectionDiff,
  type TenantConfigDocument,
  type TenantConfigSectionKey,
  type TenantConfigSections,
} from "@hireops/api-types";

export type SqlHandle = typeof poolSql;
type Json = Record<string, unknown>;

export interface ConfigActor {
  /** auth user id recorded as app.actor_user_id (tenant audit). */
  userId: string | null;
  membershipId?: string | null;
  requestId: string | null;
  source: "app" | "system";
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/** Keys that must never leave a tenant inside a source's free-form config bag. */
const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|credential|private)/i;

/**
 * Run `fn` in ONE service-role transaction with the audit session vars set.
 */
export async function withConfigTx<T>(
  sql: SqlHandle,
  actor: ConfigActor,
  fn: (tx: SqlHandle) => Promise<T>,
): Promise<T> {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as SqlHandle;
    await tx`SELECT set_config('app.actor_user_id', ${actor.userId ?? ""}, true),
                    set_config('app.actor_membership_id', ${actor.membershipId ?? ""}, true),
                    set_config('app.request_id', ${actor.requestId ?? ""}, true),
                    set_config('app.source', ${actor.source}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Does this schema have tenant-scoped document types (C1-BUGS BUG-4)? */
export async function documentTypesAreTenantScoped(sql: SqlHandle): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'document_types' AND column_name = 'tenant_id'
  `;
  return (r?.n ?? 0) > 0;
}

// ─────────────────────────── read ───────────────────────────

export interface TenantConfigSnapshot {
  sections: Required<Omit<TenantConfigSections, "documentTypes">> &
    Pick<TenantConfigSections, "documentTypes">;
  /** Raw (unscrubbed) settings, for restore() on import. */
  rawSettings: Json;
  tenantSlug: string;
  starterPack: { key: string; version: number } | null;
  skipped: string[];
}

export async function readTenantConfig(
  sql: SqlHandle,
  tenantId: string,
): Promise<TenantConfigSnapshot> {
  const [t] = await sql<{ slug: string; settings: Json | null }[]>`
    SELECT slug, settings FROM public.tenants WHERE id = ${tenantId}
  `;
  if (!t) throw new Error("tenant_not_found");
  const raw = isRecord(t.settings) ? t.settings : {};

  const settings: Record<string, Json> = {};
  for (const def of TENANT_SETTINGS_BLOCKS) {
    const block = raw[def.key];
    if (!isRecord(block)) continue;
    settings[def.key] = def.scrub ? def.scrub(block) : block;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const locale = {
    currency: str(raw.currency),
    timezone: str(raw.timezone),
    locale: str(raw.locale),
    // Normalised (upper-case, known calling code) so a hand-edited value can't
    // produce a document that fails its own import validation.
    defaultCountry: resolveTenantDefaultCountry(raw),
  };
  const sp = raw.starterPack;
  const starterPack =
    isRecord(sp) && typeof sp.key === "string" && typeof sp.version === "number"
      ? { key: sp.key, version: sp.version }
      : null;

  const lookups = await sql<
    {
      kind: string;
      key: string;
      label: string;
      sort_order: number;
      is_active: boolean;
      attrs: Json;
    }[]
  >`
    SELECT kind, key, label, sort_order, is_active, attrs FROM public.tenant_lookups
     WHERE tenant_id = ${tenantId} ORDER BY kind, key
  `;
  const legalEntities = await sql<{ name: string; country_code: string; is_active: boolean }[]>`
    SELECT name, country_code, is_active FROM public.legal_entities
     WHERE tenant_id = ${tenantId} ORDER BY name
  `;
  const locations = await sql<
    {
      name: string;
      city: string | null;
      region: string | null;
      country_code: string;
      entity: string | null;
      timezone: string | null;
      is_active: boolean;
    }[]
  >`
    SELECT l.name, l.city, l.region, l.country_code, e.name AS entity, l.timezone, l.is_active
      FROM public.locations l
      LEFT JOIN public.legal_entities e ON e.id = l.legal_entity_id AND e.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${tenantId} ORDER BY l.name
  `;
  const businessUnits = await sql<
    {
      slug: string;
      name: string;
      parent: string | null;
      entity: string | null;
      is_archived: boolean;
    }[]
  >`
    SELECT b.slug, b.name, p.slug AS parent, e.name AS entity, b.is_archived
      FROM public.business_units b
      LEFT JOIN public.business_units p ON p.id = b.parent_business_unit_id AND p.tenant_id = b.tenant_id
      LEFT JOIN public.legal_entities e ON e.id = b.legal_entity_id AND e.tenant_id = b.tenant_id
     WHERE b.tenant_id = ${tenantId} ORDER BY b.slug
  `;
  const jobFunctions = await sql<
    { key: string; label: string; sort_order: number; is_active: boolean }[]
  >`
    SELECT key, label, sort_order, is_active FROM public.job_functions
     WHERE tenant_id = ${tenantId} ORDER BY sort_order, key
  `;
  const jobLevels = await sql<{ key: string; label: string; rank: number; is_active: boolean }[]>`
    SELECT key, label, rank, is_active FROM public.job_levels
     WHERE tenant_id = ${tenantId} ORDER BY rank, key
  `;
  const jdTemplates = await sql<
    {
      title: string;
      label: string;
      role_family: string;
      seniority: string;
      location_type: string;
      budget_min_inr: string | number;
      budget_max_inr: string | number;
      extra_context: string;
      body_md: string;
      legal_clauses: string;
      skills: unknown;
      is_archived: boolean;
      sort_order: number;
    }[]
  >`
    SELECT title, label, role_family, seniority, location_type, budget_min_inr, budget_max_inr,
           extra_context, body_md, legal_clauses, skills, is_archived, sort_order
      FROM public.jd_templates WHERE tenant_id = ${tenantId} ORDER BY sort_order, title
  `;
  const jobProfiles = await sql<
    {
      title: string;
      fn: string | null;
      lmin: string | null;
      lmax: string | null;
      jd: string | null;
      competencies: unknown;
      canonical_market_title: string | null;
      is_active: boolean;
    }[]
  >`
    SELECT p.title, f.key AS fn, lmin.key AS lmin, lmax.key AS lmax, j.title AS jd,
           p.competencies, p.canonical_market_title, p.is_active
      FROM public.job_profiles p
      LEFT JOIN public.job_functions f ON f.id = p.job_function_id AND f.tenant_id = p.tenant_id
      LEFT JOIN public.job_levels lmin ON lmin.id = p.job_level_min_id AND lmin.tenant_id = p.tenant_id
      LEFT JOIN public.job_levels lmax ON lmax.id = p.job_level_max_id AND lmax.tenant_id = p.tenant_id
      LEFT JOIN public.jd_templates j ON j.id = p.default_jd_template_id AND j.tenant_id = p.tenant_id
     WHERE p.tenant_id = ${tenantId} ORDER BY p.title
  `;
  const compBands = await sql<
    {
      name: string;
      level: string | null;
      currency: string;
      min_major: string;
      max_major: string;
      midpoint_major: string | null;
      lvl: string | null;
      fn: string | null;
      loc: string | null;
      is_archived: boolean;
    }[]
  >`
    SELECT c.name, c.level, c.currency, c.min_major::text AS min_major, c.max_major::text AS max_major,
           c.midpoint_major::text AS midpoint_major, l.key AS lvl, f.key AS fn, loc.name AS loc,
           c.is_archived
      FROM public.comp_bands c
      LEFT JOIN public.job_levels l ON l.id = c.job_level_id AND l.tenant_id = c.tenant_id
      LEFT JOIN public.job_functions f ON f.id = c.job_function_id AND f.tenant_id = c.tenant_id
      LEFT JOIN public.locations loc ON loc.id = c.location_id AND loc.tenant_id = c.tenant_id
     WHERE c.tenant_id = ${tenantId} ORDER BY c.name
  `;
  const scorecards = await sql<{ scorecard_key: string; label: string; criteria: unknown }[]>`
    SELECT scorecard_key, label, criteria FROM public.tenant_scorecard_template
     WHERE tenant_id = ${tenantId} ORDER BY scorecard_key
  `;
  const loops = await sql<{ id: string; loop_key: string; label: string; is_active: boolean }[]>`
    SELECT id::text AS id, loop_key, label, is_active FROM public.interview_loops
     WHERE tenant_id = ${tenantId} ORDER BY loop_key
  `;
  const rounds = await sql<
    {
      loop_key: string;
      round_number: number;
      round_name: string;
      duration_minutes: number;
      mode: string;
      scorecard_template_key: string | null;
      competency_focus: unknown;
    }[]
  >`
    SELECT loop_key, round_number, round_name, duration_minutes, mode, scorecard_template_key,
           competency_focus
      FROM public.tenant_interview_round_template
     WHERE tenant_id = ${tenantId} ORDER BY loop_key, round_number
  `;
  const emailOverrides = await sql<
    {
      template_key: string;
      subject_override: string | null;
      slot_overrides: unknown;
      enabled: boolean;
    }[]
  >`
    SELECT template_key, subject_override, slot_overrides, enabled
      FROM public.tenant_email_template_overrides
     WHERE tenant_id = ${tenantId} ORDER BY template_key
  `;
  const fieldPolicy = await sql<
    { field_key: string; requiredness: string; blocks_advance_stage: string | null }[]
  >`
    SELECT field_key, requiredness, blocks_advance_stage FROM public.candidate_field_policy
     WHERE tenant_id = ${tenantId} ORDER BY field_key
  `;
  const sources = await sql<
    {
      source_enum: string;
      label: string;
      enabled: boolean;
      ingestion_mode: string;
      config: unknown;
      notes: string | null;
    }[]
  >`
    SELECT source_enum::text AS source_enum, label, enabled, ingestion_mode, config, notes
      FROM public.tenant_application_sources
     WHERE tenant_id = ${tenantId} ORDER BY source_enum
  `;
  const matrices = await sql<
    {
      subject_type: string;
      name: string;
      rules: unknown;
      effective_from: Date;
      effective_to: Date | null;
    }[]
  >`
    SELECT subject_type::text AS subject_type, name, rules, effective_from, effective_to
      FROM public.approval_matrices
     WHERE tenant_id = ${tenantId} ORDER BY subject_type, name, effective_from
  `;
  const pools = await sql<{ name: string; focus: string | null; is_archived: boolean }[]>`
    SELECT name, focus, is_archived FROM public.panel_pools
     WHERE tenant_id = ${tenantId} ORDER BY name
  `;

  const skipped: string[] = [];
  const templateAssignments = await readTemplateAssignments(sql, tenantId, loops, skipped);
  let documentTypes: TenantConfigSections["documentTypes"];
  if (await documentTypesAreTenantScoped(sql)) {
    const rows = await sql.unsafe<
      {
        code: string;
        name: string;
        geography_code: string | null;
        required_for_lifecycle_stage: string | null;
        retention_years: number | null;
      }[]
    >(
      `SELECT code, name, geography_code, required_for_lifecycle_stage, retention_years
         FROM public.document_types WHERE tenant_id = $1 ORDER BY code`,
      [tenantId],
    );
    documentTypes = rows.map((r) => ({
      code: r.code,
      name: r.name,
      geographyCode: r.geography_code ? r.geography_code.trim() : null,
      requiredForLifecycleStage: r.required_for_lifecycle_stage,
      retentionYears: r.retention_years,
    }));
  } else {
    skipped.push(
      "documentTypes: document types are platform-wide on this schema (not tenant data)",
    );
  }

  // Approval rules naming a specific person (a uuid / email ref) are people
  // data — such matrices are skipped and reported, never exported.
  const PERSON_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|@/i;
  const approvalMatrices: NonNullable<TenantConfigSections["approvalMatrices"]> = [];
  for (const m of matrices) {
    const rules = isRecord(m.rules) ? m.rules : {};
    const steps = Array.isArray(rules.steps) ? rules.steps : [];
    const namesPerson = steps.some(
      (s) =>
        isRecord(s) && typeof s.approver_ref === "string" && PERSON_REF_RE.test(s.approver_ref),
    );
    if (namesPerson) {
      skipped.push(`approvalMatrices: "${m.name}" names a person as approver — not exported`);
      continue;
    }
    approvalMatrices.push({
      subjectType: m.subject_type as "requisition" | "offer",
      name: m.name,
      rules,
      effectiveFrom: iso(m.effective_from) as string,
      effectiveTo: iso(m.effective_to),
    });
  }

  return {
    tenantSlug: t.slug,
    starterPack,
    rawSettings: raw,
    skipped,
    sections: {
      settings,
      locale,
      lookups: lookups.map((r) => ({
        kind: r.kind,
        key: r.key,
        label: r.label,
        sortOrder: r.sort_order,
        isActive: r.is_active,
        attrs: (isRecord(r.attrs) ? r.attrs : {}) as Record<string, string | number | boolean>,
      })),
      legalEntities: legalEntities.map((r) => ({
        name: r.name,
        countryCode: r.country_code,
        isActive: r.is_active,
      })),
      locations: locations.map((r) => ({
        name: r.name,
        city: r.city,
        region: r.region,
        countryCode: r.country_code,
        legalEntity: r.entity,
        timezone: r.timezone,
        isActive: r.is_active,
      })),
      businessUnits: businessUnits.map((r) => ({
        slug: r.slug,
        name: r.name,
        parent: r.parent,
        legalEntity: r.entity,
        isArchived: r.is_archived,
      })),
      jobFunctions: jobFunctions.map((r) => ({
        key: r.key,
        label: r.label,
        sortOrder: r.sort_order,
        isActive: r.is_active,
      })),
      jobLevels: jobLevels.map((r) => ({
        key: r.key,
        label: r.label,
        rank: r.rank,
        isActive: r.is_active,
      })),
      jdTemplates: jdTemplates.map((r) => ({
        title: r.title,
        label: r.label,
        roleFamily: r.role_family,
        seniority: r.seniority,
        locationType: r.location_type as "remote" | "hybrid" | "onsite" | "multi",
        budgetMinInr: Number(r.budget_min_inr),
        budgetMaxInr: Number(r.budget_max_inr),
        extraContext: r.extra_context,
        bodyMd: r.body_md,
        legalClauses: r.legal_clauses,
        skills: Array.isArray(r.skills) ? r.skills : [],
        isArchived: r.is_archived,
        sortOrder: r.sort_order,
      })),
      jobProfiles: jobProfiles.map((r) => ({
        title: r.title,
        jobFunction: r.fn,
        levelMin: r.lmin,
        levelMax: r.lmax,
        defaultJdTemplate: r.jd,
        competencies: Array.isArray(r.competencies)
          ? (r.competencies as { key: string; label: string }[])
          : [],
        canonicalMarketTitle: r.canonical_market_title,
        isActive: r.is_active,
      })),
      compBands: compBands.map((r) => ({
        name: r.name,
        level: r.level,
        currency: r.currency.trim(),
        minMajor: r.min_major,
        maxMajor: r.max_major,
        midpointMajor: r.midpoint_major,
        jobLevel: r.lvl,
        jobFunction: r.fn,
        location: r.loc,
        isArchived: r.is_archived,
      })),
      scorecardTemplates: scorecards.map((r) => ({
        scorecardKey: r.scorecard_key,
        label: r.label,
        criteria: Array.isArray(r.criteria) ? (r.criteria as { key: string; label: string }[]) : [],
      })),
      interviewLoops: loops.map((r) => ({
        loopKey: r.loop_key,
        label: r.label,
        isActive: r.is_active,
      })),
      interviewRounds: rounds.map((r) => ({
        // The 'default' loop travels without a loopKey (documents from before
        // named loops are byte-identical).
        ...(r.loop_key === "default" ? {} : { loopKey: r.loop_key }),
        roundNumber: r.round_number,
        roundName: r.round_name,
        durationMinutes: r.duration_minutes,
        mode: r.mode as "video" | "onsite" | "phone",
        scorecardTemplateKey: r.scorecard_template_key,
        competencyFocus: Array.isArray(r.competency_focus) ? (r.competency_focus as string[]) : [],
      })),
      templateAssignments,
      emailTemplateOverrides: emailOverrides.map((r) => ({
        templateKey: r.template_key,
        subjectOverride: r.subject_override,
        slotOverrides: (isRecord(r.slot_overrides) ? r.slot_overrides : {}) as Record<
          string,
          string
        >,
        enabled: r.enabled,
      })),
      candidateFieldPolicy: fieldPolicy.map((r) => ({
        fieldKey: r.field_key,
        requiredness: r.requiredness as "required" | "optional",
        blocksAdvanceStage: r.blocks_advance_stage,
      })),
      sources: sources.map((r) => ({
        sourceEnum: r.source_enum,
        label: r.label,
        enabled: r.enabled,
        ingestionMode: r.ingestion_mode as "manual" | "connector_pending",
        config: Object.fromEntries(
          Object.entries(isRecord(r.config) ? r.config : {}).filter(
            ([k, v]) => typeof v === "string" && !SECRET_KEY_RE.test(k),
          ),
        ) as Record<string, string>,
        notes: r.notes,
      })),
      approvalMatrices,
      panelPools: pools.map((r) => ({ name: r.name, focus: r.focus, isArchived: r.is_archived })),
      ...(documentTypes ? { documentTypes } : {}),
    },
  };
}

// ─────────────────────────── C2-F12 template assignments ───────────────────────────

/** id ↔ natural key per condition attribute that references a tenant row. */
const CONDITION_REF_SQL: Record<string, string> = {
  legal_entity_id:
    "SELECT id::text AS id, name AS k FROM public.legal_entities WHERE tenant_id = $1",
  business_unit_id:
    "SELECT id::text AS id, slug AS k FROM public.business_units WHERE tenant_id = $1",
  location_id: "SELECT id::text AS id, name AS k FROM public.locations WHERE tenant_id = $1",
  job_function_id: "SELECT id::text AS id, key AS k FROM public.job_functions WHERE tenant_id = $1",
  job_profile_id: "SELECT id::text AS id, title AS k FROM public.job_profiles WHERE tenant_id = $1",
};

async function conditionRefMaps(
  sql: SqlHandle,
  tenantId: string,
): Promise<Record<string, { toKey: Map<string, string>; toId: Map<string, string> }>> {
  const out: Record<string, { toKey: Map<string, string>; toId: Map<string, string> }> = {};
  for (const [attr, q] of Object.entries(CONDITION_REF_SQL)) {
    const rows = await sql.unsafe<{ id: string; k: string }[]>(q, [tenantId]);
    out[attr] = {
      toKey: new Map(rows.map((r) => [r.id, r.k] as const)),
      toId: new Map(rows.map((r) => [r.k, r.id] as const)),
    };
  }
  return out;
}

/**
 * Translate a conditions object between ids and natural keys. Returns null
 * (with the reason) when a referenced row can't be found on this side.
 */
function translateConditions(
  conditions: Record<string, unknown>,
  maps: Awaited<ReturnType<typeof conditionRefMaps>>,
  dir: "toKey" | "toId",
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const out: Record<string, unknown> = {};
  for (const [attr, pred] of Object.entries(conditions)) {
    const m = maps[attr];
    if (!m || !isRecord(pred) || !Array.isArray(pred.in)) {
      out[attr] = pred;
      continue;
    }
    const vals: string[] = [];
    for (const v of pred.in as string[]) {
      const t = m[dir].get(v);
      if (t === undefined) return { ok: false, reason: `${attr} "${v}" not found` };
      vals.push(t);
    }
    out[attr] = { in: vals };
  }
  return { ok: true, value: out };
}

async function readTemplateAssignments(
  sql: SqlHandle,
  tenantId: string,
  loops: { id: string; loop_key: string }[],
  skipped: string[],
): Promise<NonNullable<TenantConfigSections["templateAssignments"]>> {
  const rows = await sql<
    {
      template_kind: string;
      name: string;
      template_id: string;
      priority: number;
      is_active: boolean;
      conditions: unknown;
    }[]
  >`
    SELECT template_kind, name, template_id::text AS template_id, priority, is_active, conditions
      FROM public.template_assignments
     WHERE tenant_id = ${tenantId} ORDER BY template_kind, name
  `;
  if (rows.length === 0) return [];
  const scorecards = await sql<{ id: string; scorecard_key: string }[]>`
    SELECT id::text AS id, scorecard_key FROM public.tenant_scorecard_template
     WHERE tenant_id = ${tenantId}
  `;
  const targetKey: Record<string, Map<string, string>> = {
    interview_loop: new Map(loops.map((l) => [l.id, l.loop_key] as const)),
    scorecard: new Map(scorecards.map((c) => [c.id, c.scorecard_key] as const)),
  };
  const maps = await conditionRefMaps(sql, tenantId);
  const out: NonNullable<TenantConfigSections["templateAssignments"]> = [];
  for (const r of rows) {
    const template = targetKey[r.template_kind]?.get(r.template_id);
    const parsed = parseStoredConditions(r.conditions);
    if (!template || !parsed) {
      skipped.push(
        `templateAssignments: "${r.name}" (${r.template_kind}) — ${!template ? "its template no longer exists" : "its conditions are malformed"}; not exported`,
      );
      continue;
    }
    const t = translateConditions(parsed as Record<string, unknown>, maps, "toKey");
    if (!t.ok) {
      skipped.push(`templateAssignments: "${r.name}" — ${t.reason}; not exported`);
      continue;
    }
    out.push({
      templateKind: r.template_kind,
      name: r.name,
      template,
      priority: Number(r.priority),
      isActive: r.is_active,
      conditions: t.value as ConfigApplicabilityConditions,
    });
  }
  return out;
}

/** The export document for a tenant. */
export async function exportTenantConfigDocument(
  sql: SqlHandle,
  tenantId: string,
): Promise<{ document: TenantConfigDocument; skipped: string[] }> {
  const snap = await readTenantConfig(sql, tenantId);
  return {
    document: {
      format: TENANT_CONFIG_FORMAT,
      schemaVersion: TENANT_CONFIG_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      source: { tenantSlug: snap.tenantSlug, starterPack: snap.starterPack },
      sections: snap.sections,
    },
    skipped: snap.skipped,
  };
}

// ─────────────────────────── apply ───────────────────────────

export interface ApplyResult {
  diff: ConfigSectionDiff[];
  skipped: string[];
}

class IdMap {
  private m = new Map<string, string>();
  constructor(rows: { k: string; id: string }[]) {
    for (const r of rows) this.m.set(r.k, r.id);
  }
  get(k: string | null | undefined): string | null {
    if (k === null || k === undefined) return null;
    return this.m.get(k) ?? null;
  }
}

/**
 * Compute the diff against the tenant's current configuration and apply it
 * inside `tx` (the caller's transaction). Returns the diff that was applied.
 */
export async function applyTenantConfig(
  tx: SqlHandle,
  tenantId: string,
  incoming: TenantConfigSections,
  mode: "replace" | "additive",
): Promise<ApplyResult> {
  const snap = await readTenantConfig(tx, tenantId);
  const diff = diffTenantConfig(snap.sections, incoming, mode);
  const skipped: string[] = [];
  const touched = (d: ConfigSectionDiff) => new Set([...d.adds, ...d.changes]);
  const docTypesScoped = await documentTypesAreTenantScoped(tx);

  for (const d of diff) {
    const section = d.section as TenantConfigSectionKey;
    const want = touched(d);
    if (want.size === 0 && d.removals.length === 0) continue;
    const byKey = <T>(list: T[] | undefined) =>
      new Map((list ?? []).map((r) => [configRecordKey(section, r), r] as const));

    switch (section) {
      case "settings": {
        const inc = (incoming.settings ?? {}) as Record<string, Json>;
        const next: Record<string, Json> = {};
        for (const key of want) {
          const def = settingsBlockDef(key);
          const block = inc[key];
          if (!def || !block) continue;
          const existing = snap.rawSettings[key];
          next[key] = def.restore
            ? def.restore(block, isRecord(existing) ? existing : undefined)
            : block;
        }
        await tx`
          UPDATE public.tenants
             SET settings = (COALESCE(settings, '{}'::jsonb) - ${d.removals}::text[])
                            || ${JSON.stringify(next)}::jsonb
           WHERE id = ${tenantId}
        `;
        break;
      }
      case "locale": {
        const loc = incoming.locale;
        if (!loc) break;
        const patch: Json = {};
        for (const f of want) patch[f] = (loc as Json)[f];
        await tx`
          UPDATE public.tenants
             SET settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
           WHERE id = ${tenantId}
        `;
        break;
      }
      case "lookups": {
        const m = byKey(incoming.lookups);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.tenant_lookups (tenant_id, kind, key, label, sort_order, is_active, attrs)
            VALUES (${tenantId}, ${r.kind}, ${r.key}, ${r.label}, ${r.sortOrder}, ${r.isActive},
                    ${JSON.stringify(r.attrs)}::jsonb)
            ON CONFLICT (tenant_id, kind, key) DO UPDATE
              SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
                  is_active = EXCLUDED.is_active, attrs = EXCLUDED.attrs, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          const [kind, key] = k.split(":");
          await tx`DELETE FROM public.tenant_lookups
                    WHERE tenant_id = ${tenantId} AND kind = ${kind ?? ""} AND key = ${key ?? ""}`;
        }
        break;
      }
      case "legalEntities": {
        const m = byKey(incoming.legalEntities);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.legal_entities (tenant_id, name, country_code, is_active)
            VALUES (${tenantId}, ${r.name}, ${r.countryCode}, ${r.isActive})
            ON CONFLICT (tenant_id, name) DO UPDATE
              SET country_code = EXCLUDED.country_code, is_active = EXCLUDED.is_active, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.legal_entities SET is_active = false, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND name = ${k}`;
        }
        break;
      }
      case "locations": {
        const ents = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT name AS k, id::text AS id FROM public.legal_entities WHERE tenant_id = ${tenantId}`,
        );
        const m = byKey(incoming.locations);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.locations
              (tenant_id, name, city, region, country_code, legal_entity_id, timezone, is_active)
            VALUES (${tenantId}, ${r.name}, ${r.city}, ${r.region}, ${r.countryCode},
                    ${ents.get(r.legalEntity)}, ${r.timezone}, ${r.isActive})
            ON CONFLICT (tenant_id, name) DO UPDATE
              SET city = EXCLUDED.city, region = EXCLUDED.region, country_code = EXCLUDED.country_code,
                  legal_entity_id = EXCLUDED.legal_entity_id, timezone = EXCLUDED.timezone,
                  is_active = EXCLUDED.is_active, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.locations SET is_active = false, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND name = ${k}`;
        }
        break;
      }
      case "businessUnits": {
        const ents = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT name AS k, id::text AS id FROM public.legal_entities WHERE tenant_id = ${tenantId}`,
        );
        const m = byKey(incoming.businessUnits);
        // Pass 1: rows without parents; pass 2: parents (any order of the file works).
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.business_units (tenant_id, name, slug, legal_entity_id, is_archived)
            VALUES (${tenantId}, ${r.name}, ${r.slug}, ${ents.get(r.legalEntity)}, ${r.isArchived})
            ON CONFLICT (tenant_id, slug) DO UPDATE
              SET name = EXCLUDED.name, legal_entity_id = EXCLUDED.legal_entity_id,
                  is_archived = EXCLUDED.is_archived, updated_at = now()
          `;
        }
        const bus = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT slug AS k, id::text AS id FROM public.business_units WHERE tenant_id = ${tenantId}`,
        );
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`UPDATE public.business_units SET parent_business_unit_id = ${bus.get(r.parent)}
                    WHERE tenant_id = ${tenantId} AND slug = ${r.slug}`;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.business_units SET is_archived = true, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND slug = ${k}`;
        }
        break;
      }
      case "jobFunctions": {
        const m = byKey(incoming.jobFunctions);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.job_functions (tenant_id, key, label, sort_order, is_active)
            VALUES (${tenantId}, ${r.key}, ${r.label}, ${r.sortOrder}, ${r.isActive})
            ON CONFLICT (tenant_id, key) DO UPDATE
              SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order,
                  is_active = EXCLUDED.is_active, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.job_functions SET is_active = false, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND key = ${k}`;
        }
        break;
      }
      case "jobLevels": {
        const m = byKey(incoming.jobLevels);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.job_levels (tenant_id, key, label, rank, is_active)
            VALUES (${tenantId}, ${r.key}, ${r.label}, ${r.rank}, ${r.isActive})
            ON CONFLICT (tenant_id, key) DO UPDATE
              SET label = EXCLUDED.label, rank = EXCLUDED.rank,
                  is_active = EXCLUDED.is_active, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.job_levels SET is_active = false, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND key = ${k}`;
        }
        break;
      }
      case "jdTemplates": {
        const m = byKey(incoming.jdTemplates);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.jd_templates
              (tenant_id, label, title, role_family, seniority, location_type, budget_min_inr,
               budget_max_inr, extra_context, body_md, legal_clauses, skills, is_archived, sort_order)
            VALUES (${tenantId}, ${r.label}, ${r.title}, ${r.roleFamily}, ${r.seniority},
                    ${r.locationType}, ${r.budgetMinInr}, ${r.budgetMaxInr}, ${r.extraContext},
                    ${r.bodyMd}, ${r.legalClauses}, ${JSON.stringify(r.skills)}::jsonb,
                    ${r.isArchived}, ${r.sortOrder})
            ON CONFLICT (tenant_id, title) DO UPDATE
              SET label = EXCLUDED.label, role_family = EXCLUDED.role_family,
                  seniority = EXCLUDED.seniority, location_type = EXCLUDED.location_type,
                  budget_min_inr = EXCLUDED.budget_min_inr, budget_max_inr = EXCLUDED.budget_max_inr,
                  extra_context = EXCLUDED.extra_context, body_md = EXCLUDED.body_md,
                  legal_clauses = EXCLUDED.legal_clauses, skills = EXCLUDED.skills,
                  is_archived = EXCLUDED.is_archived, sort_order = EXCLUDED.sort_order,
                  updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.jd_templates SET is_archived = true, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND title = ${k}`;
        }
        break;
      }
      case "jobProfiles": {
        const fns = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT key AS k, id::text AS id FROM public.job_functions WHERE tenant_id = ${tenantId}`,
        );
        const lvls = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT key AS k, id::text AS id FROM public.job_levels WHERE tenant_id = ${tenantId}`,
        );
        const jds = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT title AS k, id::text AS id FROM public.jd_templates WHERE tenant_id = ${tenantId}`,
        );
        const m = byKey(incoming.jobProfiles);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.job_profiles
              (tenant_id, title, job_function_id, job_level_min_id, job_level_max_id,
               default_jd_template_id, competencies, canonical_market_title, is_active)
            VALUES (${tenantId}, ${r.title}, ${fns.get(r.jobFunction)}, ${lvls.get(r.levelMin)},
                    ${lvls.get(r.levelMax)}, ${jds.get(r.defaultJdTemplate)},
                    ${JSON.stringify(r.competencies)}::jsonb, ${r.canonicalMarketTitle}, ${r.isActive})
            ON CONFLICT (tenant_id, title) DO UPDATE
              SET job_function_id = EXCLUDED.job_function_id,
                  job_level_min_id = EXCLUDED.job_level_min_id,
                  job_level_max_id = EXCLUDED.job_level_max_id,
                  default_jd_template_id = EXCLUDED.default_jd_template_id,
                  competencies = EXCLUDED.competencies,
                  canonical_market_title = EXCLUDED.canonical_market_title,
                  is_active = EXCLUDED.is_active, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.job_profiles SET is_active = false, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND title = ${k}`;
        }
        break;
      }
      case "compBands": {
        const fns = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT key AS k, id::text AS id FROM public.job_functions WHERE tenant_id = ${tenantId}`,
        );
        const lvls = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT key AS k, id::text AS id FROM public.job_levels WHERE tenant_id = ${tenantId}`,
        );
        const locs = new IdMap(
          await tx<{ k: string; id: string }[]>`
            SELECT name AS k, id::text AS id FROM public.locations WHERE tenant_id = ${tenantId}`,
        );
        const m = byKey(incoming.compBands);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.comp_bands
              (tenant_id, name, level, currency, min_major, max_major, midpoint_major,
               job_level_id, job_function_id, location_id, is_archived)
            VALUES (${tenantId}, ${r.name}, ${r.level}, ${r.currency}, ${r.minMajor}::numeric,
                    ${r.maxMajor}::numeric, ${r.midpointMajor}::numeric, ${lvls.get(r.jobLevel)},
                    ${fns.get(r.jobFunction)}, ${locs.get(r.location)}, ${r.isArchived})
            ON CONFLICT (tenant_id, name) DO UPDATE
              SET level = EXCLUDED.level, currency = EXCLUDED.currency,
                  min_major = EXCLUDED.min_major, max_major = EXCLUDED.max_major,
                  midpoint_major = EXCLUDED.midpoint_major, job_level_id = EXCLUDED.job_level_id,
                  job_function_id = EXCLUDED.job_function_id, location_id = EXCLUDED.location_id,
                  is_archived = EXCLUDED.is_archived, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.comp_bands SET is_archived = true, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND name = ${k}`;
        }
        break;
      }
      case "scorecardTemplates": {
        const m = byKey(incoming.scorecardTemplates);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.tenant_scorecard_template (tenant_id, scorecard_key, label, criteria)
            VALUES (${tenantId}, ${r.scorecardKey}, ${r.label}, ${JSON.stringify(r.criteria)}::jsonb)
            ON CONFLICT (tenant_id, scorecard_key) DO UPDATE
              SET label = EXCLUDED.label, criteria = EXCLUDED.criteria, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`DELETE FROM public.tenant_scorecard_template
                    WHERE tenant_id = ${tenantId} AND scorecard_key = ${k}`;
        }
        break;
      }
      case "interviewLoops": {
        const m = byKey(incoming.interviewLoops);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.interview_loops (tenant_id, loop_key, label, is_active)
            VALUES (${tenantId}, ${r.loopKey}, ${r.label}, ${r.loopKey === "default" ? true : r.isActive})
            ON CONFLICT (tenant_id, loop_key) DO UPDATE
              SET label = EXCLUDED.label, is_active = EXCLUDED.is_active, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          if (k === "default") continue; // the fallback loop is never deactivated
          await tx`UPDATE public.interview_loops SET is_active = false, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND loop_key = ${k}`;
        }
        break;
      }
      case "interviewRounds": {
        const m = byKey(incoming.interviewRounds);
        for (const k of d.removals) {
          const { loopKey, roundNumber } = parseInterviewRoundRecordKey(k);
          await tx`DELETE FROM public.tenant_interview_round_template
                    WHERE tenant_id = ${tenantId} AND loop_key = ${loopKey}
                      AND round_number = ${roundNumber}`;
        }
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          const loopKey = r.loopKey ?? "default";
          // A round's loop always exists (a document may carry rounds without
          // an interviewLoops section — e.g. one exported before C2-F12).
          await tx`
            INSERT INTO public.interview_loops (tenant_id, loop_key, label)
            VALUES (${tenantId}, ${loopKey}, ${loopKey === "default" ? "Default loop" : loopKey})
            ON CONFLICT (tenant_id, loop_key) DO NOTHING
          `;
          await tx`
            INSERT INTO public.tenant_interview_round_template
              (tenant_id, loop_key, round_number, round_name, duration_minutes, mode,
               scorecard_template_key, competency_focus)
            VALUES (${tenantId}, ${loopKey}, ${r.roundNumber}, ${r.roundName}, ${r.durationMinutes},
                    ${r.mode}, ${r.scorecardTemplateKey},
                    ${JSON.stringify(r.competencyFocus)}::jsonb)
            ON CONFLICT (tenant_id, loop_key, round_number) DO UPDATE
              SET round_name = EXCLUDED.round_name, duration_minutes = EXCLUDED.duration_minutes,
                  mode = EXCLUDED.mode, scorecard_template_key = EXCLUDED.scorecard_template_key,
                  competency_focus = EXCLUDED.competency_focus, updated_at = now()
          `;
        }
        break;
      }
      case "templateAssignments": {
        const m = byKey(incoming.templateAssignments);
        if (want.size > 0) {
          await tx`
            INSERT INTO public.interview_loops (tenant_id, loop_key, label)
            VALUES (${tenantId}, 'default', 'Default loop')
            ON CONFLICT (tenant_id, loop_key) DO NOTHING
          `;
        }
        const targetIds: Record<string, IdMap> = {
          interview_loop: new IdMap(
            await tx<{ k: string; id: string }[]>`
              SELECT loop_key AS k, id::text AS id FROM public.interview_loops
               WHERE tenant_id = ${tenantId}`,
          ),
          scorecard: new IdMap(
            await tx<{ k: string; id: string }[]>`
              SELECT scorecard_key AS k, id::text AS id FROM public.tenant_scorecard_template
               WHERE tenant_id = ${tenantId}`,
          ),
        };
        const maps = await conditionRefMaps(tx, tenantId);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          const kindMeta = TEMPLATE_KIND_META[r.templateKind as TemplateKind];
          if (!kindMeta?.consumed) {
            skipped.push(
              `templateAssignments: "${r.name}" — kind ${r.templateKind} is not assignable`,
            );
            continue;
          }
          const templateId = targetIds[r.templateKind]?.get(r.template) ?? null;
          if (!templateId) {
            skipped.push(`templateAssignments: "${r.name}" — template "${r.template}" not found`);
            continue;
          }
          const t = translateConditions(r.conditions as Record<string, unknown>, maps, "toId");
          if (!t.ok || !parseStoredConditions(t.ok ? t.value : null)) {
            skipped.push(
              `templateAssignments: "${r.name}" — ${t.ok ? "conditions are invalid" : t.reason}`,
            );
            continue;
          }
          await tx`
            INSERT INTO public.template_assignments
              (tenant_id, template_kind, name, template_id, priority, is_active, conditions)
            VALUES (${tenantId}, ${r.templateKind}, ${r.name}, ${templateId}, ${r.priority},
                    ${r.isActive}, ${JSON.stringify(t.value)}::jsonb)
            ON CONFLICT (tenant_id, template_kind, name) DO UPDATE
              SET template_id = EXCLUDED.template_id, priority = EXCLUDED.priority,
                  is_active = EXCLUDED.is_active, conditions = EXCLUDED.conditions,
                  updated_at = now()
          `;
        }
        for (const k of d.removals) {
          const i = k.indexOf(":");
          await tx`DELETE FROM public.template_assignments
                    WHERE tenant_id = ${tenantId} AND template_kind = ${k.slice(0, i)}
                      AND name = ${k.slice(i + 1)}`;
        }
        break;
      }
      case "emailTemplateOverrides": {
        const m = byKey(incoming.emailTemplateOverrides);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.tenant_email_template_overrides
              (tenant_id, template_key, subject_override, slot_overrides, enabled)
            VALUES (${tenantId}, ${r.templateKey}, ${r.subjectOverride},
                    ${JSON.stringify(r.slotOverrides)}::jsonb, ${r.enabled})
            ON CONFLICT (tenant_id, template_key) DO UPDATE
              SET subject_override = EXCLUDED.subject_override,
                  slot_overrides = EXCLUDED.slot_overrides, enabled = EXCLUDED.enabled,
                  updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`DELETE FROM public.tenant_email_template_overrides
                    WHERE tenant_id = ${tenantId} AND template_key = ${k}`;
        }
        break;
      }
      case "candidateFieldPolicy": {
        const m = byKey(incoming.candidateFieldPolicy);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.candidate_field_policy
              (tenant_id, field_key, requiredness, blocks_advance_stage)
            VALUES (${tenantId}, ${r.fieldKey}, ${r.requiredness}, ${r.blocksAdvanceStage})
            ON CONFLICT (tenant_id, field_key) DO UPDATE
              SET requiredness = EXCLUDED.requiredness,
                  blocks_advance_stage = EXCLUDED.blocks_advance_stage, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`DELETE FROM public.candidate_field_policy
                    WHERE tenant_id = ${tenantId} AND field_key = ${k}`;
        }
        break;
      }
      case "sources": {
        const m = byKey(incoming.sources);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          const config = Object.fromEntries(
            Object.entries(r.config).filter(([key]) => !SECRET_KEY_RE.test(key)),
          );
          await tx`
            INSERT INTO public.tenant_application_sources
              (tenant_id, source_enum, label, enabled, ingestion_mode, config, notes)
            VALUES (${tenantId}, ${r.sourceEnum}::public.application_source, ${r.label}, ${r.enabled},
                    ${r.ingestionMode}, ${JSON.stringify(config)}::jsonb, ${r.notes})
            ON CONFLICT (tenant_id, source_enum) DO UPDATE
              SET label = EXCLUDED.label, enabled = EXCLUDED.enabled,
                  ingestion_mode = EXCLUDED.ingestion_mode, config = EXCLUDED.config,
                  notes = EXCLUDED.notes, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`DELETE FROM public.tenant_application_sources
                    WHERE tenant_id = ${tenantId} AND source_enum::text = ${k}`;
        }
        break;
      }
      case "approvalMatrices": {
        const m = byKey(incoming.approvalMatrices);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          // (subject_type, name) is not a DB key; the latest matrix of that name is "the" one.
          const [cur] = await tx<{ id: string }[]>`
            SELECT id::text AS id FROM public.approval_matrices
             WHERE tenant_id = ${tenantId} AND subject_type::text = ${r.subjectType} AND name = ${r.name}
             ORDER BY effective_from DESC LIMIT 1
          `;
          if (cur) {
            await tx`
              UPDATE public.approval_matrices
                 SET rules = ${JSON.stringify(r.rules)}::jsonb, effective_from = ${r.effectiveFrom}::timestamptz,
                     effective_to = ${r.effectiveTo}::timestamptz, updated_at = now()
               WHERE tenant_id = ${tenantId} AND id = ${cur.id}
            `;
          } else {
            await tx`
              INSERT INTO public.approval_matrices (tenant_id, subject_type, name, rules, effective_from, effective_to)
              VALUES (${tenantId}, ${r.subjectType}::public.approval_subject_type, ${r.name},
                      ${JSON.stringify(r.rules)}::jsonb, ${r.effectiveFrom}::timestamptz,
                      ${r.effectiveTo}::timestamptz)
            `;
          }
        }
        for (const k of d.removals) {
          const idx = k.indexOf(":");
          const subject = k.slice(0, idx);
          const name = k.slice(idx + 1);
          await tx`
            UPDATE public.approval_matrices SET effective_to = now(), updated_at = now()
             WHERE tenant_id = ${tenantId} AND subject_type::text = ${subject} AND name = ${name}
               AND (effective_to IS NULL OR effective_to > now())
          `;
        }
        break;
      }
      case "panelPools": {
        const m = byKey(incoming.panelPools);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          await tx`
            INSERT INTO public.panel_pools (tenant_id, name, focus, is_archived)
            VALUES (${tenantId}, ${r.name}, ${r.focus}, ${r.isArchived})
            ON CONFLICT (tenant_id, name) DO UPDATE
              SET focus = EXCLUDED.focus, is_archived = EXCLUDED.is_archived, updated_at = now()
          `;
        }
        for (const k of d.removals) {
          await tx`UPDATE public.panel_pools SET is_archived = true, updated_at = now()
                    WHERE tenant_id = ${tenantId} AND name = ${k}`;
        }
        break;
      }
      case "documentTypes": {
        if (!docTypesScoped) {
          skipped.push(
            "documentTypes: not applied — document types are platform-wide on this schema",
          );
          break;
        }
        const m = byKey(incoming.documentTypes);
        for (const k of want) {
          const r = m.get(k);
          if (!r) continue;
          // No reliance on a particular unique constraint name: update, else insert.
          const updated = await tx.unsafe(
            `UPDATE public.document_types
                SET name = $3, geography_code = $4, required_for_lifecycle_stage = $5,
                    retention_years = $6, updated_at = now()
              WHERE tenant_id = $1 AND code = $2 RETURNING code`,
            [
              tenantId,
              r.code,
              r.name,
              r.geographyCode,
              r.requiredForLifecycleStage,
              r.retentionYears,
            ],
          );
          if (updated.length === 0) {
            await tx.unsafe(
              `INSERT INTO public.document_types
                 (tenant_id, code, name, geography_code, required_for_lifecycle_stage, retention_years)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                tenantId,
                r.code,
                r.name,
                r.geographyCode,
                r.requiredForLifecycleStage,
                r.retentionYears,
              ],
            );
          }
        }
        break;
      }
    }
  }
  return { diff, skipped: [...new Set(skipped)] };
}
