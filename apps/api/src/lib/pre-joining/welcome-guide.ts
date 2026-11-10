/**
 * PC-18 — pre-joining welcome guide per business unit (server side, shared by
 * the api and the worker).
 *
 *   - Source material: one `welcome_guide_sources` row per scope (a business
 *     unit, or business_unit_id NULL = the organisation-wide default).
 *   - Generation: the `welcome_guide` AI feature (kill switch respected) →
 *     strict JSON → `groundWelcomeGuide` post-check (invented people and
 *     ungrounded sentences dropped, and listed) → a new DRAFT version.
 *   - Review: a draft is editable; publishing it supersedes the previous
 *     published version of that scope. A published version is immutable;
 *     changing it means a new draft (copied from it, or regenerated).
 *   - Candidate: a candidate with an accepted, not-yet-joined offer sees the
 *     published guide for their requisition's business unit, else the nearest
 *     ancestor's, else the organisation default. Read receipts per section.
 *
 * Raw postgres.js with an EXPLICIT tenant_id on every statement (journey.ts
 * discipline). Candidate reads additionally filter by the caller's person id
 * — that predicate is what isolates one candidate from another.
 *
 * Outcomes that the router maps to a TRPCError are returned as
 * `{ ok: false, code, message }` (recordRenege's shape) so this module stays
 * importable by the worker without tRPC.
 */

import { sql as poolSql } from "@hireops/db";
import { getAIClient, resolveTenantAiSettings } from "@hireops/ai-client";
import {
  buildWelcomeGroundingCorpus,
  groundWelcomeGuide,
  nonEmptyWelcomeSections,
  normaliseName,
  resolveWelcomeScope,
  welcomeGroundingReportSchema,
  welcomeGuideContentSchema,
  welcomeGuideSectionKeySchema,
  welcomeSourceFieldsSchema,
  welcomeSourceHasContent,
  type CandidateGetMyWelcomeGuideOutput,
  type GetWelcomeContentOutput,
  type WelcomeGuideContent,
  type WelcomeGuideSectionKey,
  type WelcomeGuideStatus,
  type WelcomeGuideVersion,
  type WelcomeLink,
  type WelcomeScopeMatch,
  type WelcomeScopeRow,
  type WelcomeSourceFields,
} from "@hireops/api-types";
import { caseStatusMeansJoined } from "./journey";
import {
  WELCOME_GUIDE_FEATURE,
  WELCOME_GUIDE_PROMPT_VERSION,
  WELCOME_GUIDE_SCHEMA_NAME,
  buildWelcomeGuidePrompt,
  welcomeGuideAiJsonSchema,
  welcomeGuideAiSchema,
  type WelcomeGuideAiResponse,
} from "./welcome-guide-prompt";

type PgSqlClient = typeof poolSql;

export interface WelcomeFailure {
  ok: false;
  code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";
  message: string;
}
export type WelcomeResult<T> = ({ ok: true } & T) | WelcomeFailure;

const fail = (code: WelcomeFailure["code"], message: string): WelcomeFailure => ({
  ok: false,
  code,
  message,
});

function iso(v: Date | string | null | undefined): string | null {
  return v ? new Date(v).toISOString() : null;
}

// ─────────────────────────── source material ───────────────────────────

interface SourceRow {
  overview: string;
  leaders: unknown;
  culture: string;
  first_week: string;
  links: unknown;
  updated_at: Date | string;
}

function sourceFromRow(r: SourceRow | undefined): WelcomeSourceFields {
  const parsed = welcomeSourceFieldsSchema.safeParse(
    r
      ? {
          overview: r.overview,
          leaders: r.leaders,
          culture: r.culture,
          firstWeek: r.first_week,
          links: r.links,
        }
      : {},
  );
  return parsed.success ? parsed.data : welcomeSourceFieldsSchema.parse({});
}

export async function loadWelcomeSource(
  sql: PgSqlClient,
  tenantId: string,
  businessUnitId: string | null,
): Promise<{ source: WelcomeSourceFields; updatedAt: string | null; exists: boolean }> {
  const [r] = await sql<SourceRow[]>`
    SELECT overview, leaders, culture, first_week, links, updated_at
    FROM public.welcome_guide_sources
    WHERE tenant_id = ${tenantId} AND business_unit_id IS NOT DISTINCT FROM ${businessUnitId}::uuid
    LIMIT 1
  `;
  return { source: sourceFromRow(r), updatedAt: iso(r?.updated_at), exists: !!r };
}

/** The business unit (in this tenant) or null when it is not one of the tenant's. */
async function loadBusinessUnit(
  sql: PgSqlClient,
  tenantId: string,
  businessUnitId: string,
): Promise<{ id: string; name: string } | null> {
  const [bu] = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM public.business_units
    WHERE tenant_id = ${tenantId} AND id = ${businessUnitId} LIMIT 1
  `;
  return bu ?? null;
}

async function tenantDisplayName(sql: PgSqlClient, tenantId: string): Promise<string> {
  const [t] = await sql<{ display_name: string }[]>`
    SELECT display_name FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  return t?.display_name ?? "";
}

export async function upsertWelcomeSource(
  sql: PgSqlClient,
  args: {
    tenantId: string;
    membershipId: string | null;
    businessUnitId: string | null;
    source: WelcomeSourceFields;
  },
): Promise<WelcomeResult<{ id: string }>> {
  const { tenantId, businessUnitId, source } = args;
  if (businessUnitId && !(await loadBusinessUnit(sql, tenantId, businessUnitId))) {
    return fail("NOT_FOUND", "Business unit not found");
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.welcome_guide_sources
      (tenant_id, business_unit_id, overview, leaders, culture, first_week, links,
       updated_by_membership_id)
    VALUES (${tenantId}, ${businessUnitId}::uuid, ${source.overview},
            ${JSON.stringify(source.leaders)}::jsonb, ${source.culture}, ${source.firstWeek},
            ${JSON.stringify(source.links)}::jsonb, ${args.membershipId})
    ON CONFLICT (tenant_id, business_unit_id)
    DO UPDATE SET overview = EXCLUDED.overview, leaders = EXCLUDED.leaders,
                  culture = EXCLUDED.culture, first_week = EXCLUDED.first_week,
                  links = EXCLUDED.links,
                  updated_by_membership_id = EXCLUDED.updated_by_membership_id,
                  updated_at = now()
    RETURNING id
  `;
  if (!row) return fail("BAD_REQUEST", "Could not save the welcome content");
  return { ok: true, id: row.id };
}

// ─────────────────────────── admin reads ───────────────────────────

export async function listWelcomeScopes(
  sql: PgSqlClient,
  tenantId: string,
): Promise<WelcomeScopeRow[]> {
  const bus = await sql<
    { id: string; name: string; parent_business_unit_id: string | null; is_archived: boolean }[]
  >`
    SELECT id, name, parent_business_unit_id, is_archived FROM public.business_units
    WHERE tenant_id = ${tenantId}
    ORDER BY name
  `;
  const sources = await sql<{ business_unit_id: string | null }[]>`
    SELECT business_unit_id FROM public.welcome_guide_sources WHERE tenant_id = ${tenantId}
  `;
  const guides = await sql<{ business_unit_id: string | null; status: string; version: number }[]>`
    SELECT business_unit_id, status, version FROM public.welcome_guides
    WHERE tenant_id = ${tenantId} AND status IN ('draft', 'published')
  `;
  const key = (id: string | null) => id ?? "";
  const hasSource = new Set(sources.map((s) => key(s.business_unit_id)));
  const published = new Map<string, number>();
  const drafts = new Set<string>();
  for (const g of guides) {
    if (g.status === "published") published.set(key(g.business_unit_id), g.version);
    else drafts.add(key(g.business_unit_id));
  }
  const row = (
    id: string | null,
    name: string,
    parent: string | null,
    archived: boolean,
  ): WelcomeScopeRow => ({
    businessUnitId: id,
    name,
    parentBusinessUnitId: parent,
    isArchived: archived,
    hasSource: hasSource.has(key(id)),
    publishedVersion: published.get(key(id)) ?? null,
    hasDraft: drafts.has(key(id)),
  });
  return [
    row(null, "Organisation default", null, false),
    ...bus.map((b) => row(b.id, b.name, b.parent_business_unit_id, b.is_archived)),
  ];
}

interface GuideRow {
  id: string;
  version: number;
  status: string;
  content: unknown;
  grounding_report: unknown;
  model: string | null;
  prompt_version: string | null;
  edited_at: Date | string | null;
  published_at: Date | string | null;
  created_at: Date | string;
}

function guideFromRow(r: GuideRow): WelcomeGuideVersion {
  const content = welcomeGuideContentSchema.safeParse(r.content);
  const report = welcomeGroundingReportSchema.safeParse(r.grounding_report);
  return {
    id: r.id,
    version: r.version,
    status: r.status as WelcomeGuideStatus,
    content: content.success ? content.data : welcomeGuideContentSchema.parse({}),
    groundingReport: report.success ? report.data : { dropped: [] },
    model: r.model,
    promptVersion: r.prompt_version,
    editedAt: iso(r.edited_at),
    publishedAt: iso(r.published_at),
    createdAt: iso(r.created_at) ?? "",
  };
}

export async function getWelcomeContent(
  sql: PgSqlClient,
  args: { tenantId: string; businessUnitId: string | null },
): Promise<GetWelcomeContentOutput | null> {
  const { tenantId, businessUnitId } = args;
  let scopeName = "Organisation default";
  if (businessUnitId) {
    const bu = await loadBusinessUnit(sql, tenantId, businessUnitId);
    if (!bu) return null;
    scopeName = bu.name;
  }
  const src = await loadWelcomeSource(sql, tenantId, businessUnitId);
  const rows = await sql<GuideRow[]>`
    SELECT id, version, status, content, grounding_report, model, prompt_version,
           edited_at, published_at, created_at
    FROM public.welcome_guides
    WHERE tenant_id = ${tenantId} AND business_unit_id IS NOT DISTINCT FROM ${businessUnitId}::uuid
    ORDER BY version DESC
    LIMIT 50
  `;
  return {
    businessUnitId,
    scopeName,
    source: src.source,
    sourceUpdatedAt: src.updatedAt,
    versions: rows.map(guideFromRow),
  };
}

// ─────────────────────────── generation ───────────────────────────

/** Is the `welcome_guide` AI feature (kill switch) on for this tenant? */
export async function isWelcomeGenerationEnabled(
  sql: PgSqlClient,
  tenantId: string,
): Promise<boolean> {
  const aiSettings = await resolveTenantAiSettings(sql, tenantId);
  return aiSettings[WELCOME_GUIDE_FEATURE].enabled;
}

/**
 * Generate a new DRAFT version for one scope. Refusals, in order: unknown
 * business unit → NOT_FOUND; no source material → BAD_REQUEST; the
 * `welcome_guide` kill switch → BAD_REQUEST (no model call, no usage row).
 * An existing draft for the scope is discarded (kept as history).
 */
export async function generateWelcomeGuide(
  sql: PgSqlClient,
  args: {
    tenantId: string;
    businessUnitId: string | null;
    membershipId: string | null;
    requestId: string | null;
  },
): Promise<WelcomeResult<{ guide: WelcomeGuideVersion }>> {
  const { tenantId, businessUnitId } = args;
  let buName: string | null = null;
  if (businessUnitId) {
    const bu = await loadBusinessUnit(sql, tenantId, businessUnitId);
    if (!bu) return fail("NOT_FOUND", "Business unit not found");
    buName = bu.name;
  }
  const { source } = await loadWelcomeSource(sql, tenantId, businessUnitId);
  if (!welcomeSourceHasContent(source)) {
    return fail(
      "BAD_REQUEST",
      "Add some source material first (overview, leaders, culture or first week) — the guide is written only from what you provide.",
    );
  }
  const aiSettings = await resolveTenantAiSettings(sql, tenantId);
  const feature = aiSettings[WELCOME_GUIDE_FEATURE];
  if (!feature.enabled) {
    return fail(
      "BAD_REQUEST",
      "Welcome guide generation is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
    );
  }

  const companyName = await tenantDisplayName(sql, tenantId);
  const orgSource = businessUnitId ? (await loadWelcomeSource(sql, tenantId, null)).source : null;
  const orgUsable = orgSource && welcomeSourceHasContent(orgSource) ? orgSource : null;

  const built = buildWelcomeGuidePrompt({
    companyName,
    businessUnitName: buName,
    source,
    organisationSource: orgUsable,
  });
  const client = await getAIClient(tenantId);
  const response = await client.completeStructured<WelcomeGuideAiResponse>({
    system: built.system,
    prompt: built.user,
    model: feature.model,
    temperature: feature.temperature,
    maxTokens: feature.maxTokens,
    schema: welcomeGuideAiJsonSchema,
    schemaName: WELCOME_GUIDE_SCHEMA_NAME,
    feature: WELCOME_GUIDE_FEATURE,
    requestId: args.requestId,
    actorMembershipId: args.membershipId,
  });
  const raw = welcomeGuideAiSchema.parse(response);

  // The corpus = this scope's source + the organisation material the model
  // was shown + names the platform already knows (company, business unit).
  const corpusSource: WelcomeSourceFields = orgUsable
    ? {
        overview: `${source.overview}\n\n${orgUsable.overview}`,
        culture: `${source.culture}\n\n${orgUsable.culture}`,
        firstWeek: `${source.firstWeek}\n\n${orgUsable.firstWeek}`,
        leaders: [
          ...source.leaders,
          ...orgUsable.leaders.filter(
            (o) => !source.leaders.some((l) => normaliseName(l.name) === normaliseName(o.name)),
          ),
        ],
        links: [...source.links, ...orgUsable.links],
      }
    : source;
  const corpus = buildWelcomeGroundingCorpus(
    corpusSource,
    [companyName, buName ?? ""].filter((n) => n.length > 0),
  );
  const candidateContent = welcomeGuideContentSchema.parse({
    welcome: raw.welcome,
    businessUnit: raw.businessUnit,
    people: raw.people.map((p) => ({ name: p.name, title: "", about: p.about })),
    howWeWork: raw.howWeWork,
    firstWeek: raw.firstWeek,
    faqs: raw.faqs,
  });
  const { content, report } = groundWelcomeGuide(candidateContent, corpus);

  const snapshot = { source, organisationSource: orgUsable, companyName, businessUnitName: buName };
  const guideId = await sql.begin(async (tx) => {
    await tx`
      UPDATE public.welcome_guides SET status = 'discarded', updated_at = now()
      WHERE tenant_id = ${tenantId}
        AND business_unit_id IS NOT DISTINCT FROM ${businessUnitId}::uuid
        AND status = 'draft'
    `;
    const [v] = await tx<{ next: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next FROM public.welcome_guides
      WHERE tenant_id = ${tenantId} AND business_unit_id IS NOT DISTINCT FROM ${businessUnitId}::uuid
    `;
    const [ins] = await tx<{ id: string }[]>`
      INSERT INTO public.welcome_guides
        (tenant_id, business_unit_id, version, status, content, grounding_report,
         source_snapshot, model, prompt_version, generated_by_membership_id)
      VALUES (${tenantId}, ${businessUnitId}::uuid, ${Number(v?.next ?? 1)}, 'draft',
              ${JSON.stringify(content)}::jsonb, ${JSON.stringify(report)}::jsonb,
              ${JSON.stringify(snapshot)}::jsonb, ${feature.model},
              ${WELCOME_GUIDE_PROMPT_VERSION}, ${args.membershipId})
      RETURNING id
    `;
    return ins?.id ?? null;
  });
  if (!guideId) return fail("BAD_REQUEST", "Could not save the generated guide");
  const guide = await loadGuide(sql, tenantId, guideId);
  if (!guide) return fail("NOT_FOUND", "Guide not found");
  return { ok: true, guide: guideFromRow(guide) };
}

async function loadGuide(
  sql: PgSqlClient,
  tenantId: string,
  guideId: string,
): Promise<(GuideRow & { business_unit_id: string | null }) | null> {
  const [g] = await sql<(GuideRow & { business_unit_id: string | null })[]>`
    SELECT id, business_unit_id, version, status, content, grounding_report, model,
           prompt_version, edited_at, published_at, created_at
    FROM public.welcome_guides
    WHERE tenant_id = ${tenantId} AND id = ${guideId} LIMIT 1
  `;
  return g ?? null;
}

// ─────────────────────────── review + publish ───────────────────────────

/** Edit a DRAFT's content (human edits are not re-grounded — a person owns them). */
export async function updateWelcomeGuideDraft(
  sql: PgSqlClient,
  args: {
    tenantId: string;
    guideId: string;
    content: WelcomeGuideContent;
    membershipId: string | null;
  },
): Promise<WelcomeResult<{ guide: WelcomeGuideVersion }>> {
  const g = await loadGuide(sql, args.tenantId, args.guideId);
  if (!g) return fail("NOT_FOUND", "Guide not found");
  const rows = await sql<{ id: string }[]>`
    UPDATE public.welcome_guides
    SET content = ${JSON.stringify(args.content)}::jsonb, edited_at = now(),
        edited_by_membership_id = ${args.membershipId}, updated_at = now()
    WHERE tenant_id = ${args.tenantId} AND id = ${args.guideId} AND status = 'draft'
    RETURNING id
  `;
  if (rows.length === 0) {
    return fail(
      "CONFLICT",
      "Only a draft can be edited. Published versions are kept as they were shown — start a new draft from it instead.",
    );
  }
  const after = await loadGuide(sql, args.tenantId, args.guideId);
  return after ? { ok: true, guide: guideFromRow(after) } : fail("NOT_FOUND", "Guide not found");
}

/**
 * Publish a DRAFT: the scope's currently published version becomes
 * 'superseded', this one 'published' — one transaction, and the partial
 * unique index guarantees one published version per scope even under a race.
 */
export async function publishWelcomeGuide(
  sql: PgSqlClient,
  args: { tenantId: string; guideId: string; membershipId: string | null },
): Promise<WelcomeResult<{ version: number }>> {
  const g = await loadGuide(sql, args.tenantId, args.guideId);
  if (!g) return fail("NOT_FOUND", "Guide not found");
  if (g.status !== "draft") return fail("CONFLICT", "Only a draft can be published");
  const content = welcomeGuideContentSchema.safeParse(g.content);
  if (!content.success || nonEmptyWelcomeSections(content.data).length === 0) {
    return fail("BAD_REQUEST", "This draft is empty — add some content before publishing");
  }
  const published = await sql.begin(async (tx) => {
    await tx`
      UPDATE public.welcome_guides SET status = 'superseded', updated_at = now()
      WHERE tenant_id = ${args.tenantId}
        AND business_unit_id IS NOT DISTINCT FROM ${g.business_unit_id}::uuid
        AND status = 'published'
    `;
    return tx<{ version: number }[]>`
      UPDATE public.welcome_guides
      SET status = 'published', published_at = now(),
          published_by_membership_id = ${args.membershipId}, updated_at = now()
      WHERE tenant_id = ${args.tenantId} AND id = ${args.guideId} AND status = 'draft'
      RETURNING version
    `;
  });
  const v = published[0]?.version;
  if (v === undefined) return fail("CONFLICT", "Only a draft can be published");
  return { ok: true, version: v };
}

export async function discardWelcomeGuideDraft(
  sql: PgSqlClient,
  args: { tenantId: string; guideId: string },
): Promise<WelcomeResult<object>> {
  const g = await loadGuide(sql, args.tenantId, args.guideId);
  if (!g) return fail("NOT_FOUND", "Guide not found");
  const rows = await sql<{ id: string }[]>`
    UPDATE public.welcome_guides SET status = 'discarded', updated_at = now()
    WHERE tenant_id = ${args.tenantId} AND id = ${args.guideId} AND status = 'draft'
    RETURNING id
  `;
  return rows.length > 0 ? { ok: true } : fail("CONFLICT", "Only a draft can be discarded");
}

/**
 * A new DRAFT copied from a published (or superseded) version, so a person can
 * correct it without regenerating. Keeps model + prompt_version (the text came
 * from that generation); refuses when the scope already has a draft.
 */
export async function createWelcomeDraftFromVersion(
  sql: PgSqlClient,
  args: { tenantId: string; guideId: string; membershipId: string | null },
): Promise<WelcomeResult<{ guide: WelcomeGuideVersion }>> {
  const g = await loadGuide(sql, args.tenantId, args.guideId);
  if (!g) return fail("NOT_FOUND", "Guide not found");
  if (g.status !== "published" && g.status !== "superseded") {
    return fail("CONFLICT", "Only a published or earlier published version can be copied");
  }
  const [draft] = await sql<{ id: string }[]>`
    SELECT id FROM public.welcome_guides
    WHERE tenant_id = ${args.tenantId}
      AND business_unit_id IS NOT DISTINCT FROM ${g.business_unit_id}::uuid AND status = 'draft'
    LIMIT 1
  `;
  if (draft) return fail("CONFLICT", "This scope already has a draft — edit or discard it first");
  const [ins] = await sql<{ id: string }[]>`
    INSERT INTO public.welcome_guides
      (tenant_id, business_unit_id, version, status, content, grounding_report,
       source_snapshot, model, prompt_version, generated_by_membership_id,
       edited_at, edited_by_membership_id)
    SELECT tenant_id, business_unit_id,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM public.welcome_guides w2
             WHERE w2.tenant_id = g.tenant_id
               AND w2.business_unit_id IS NOT DISTINCT FROM g.business_unit_id),
           'draft', content, grounding_report, source_snapshot, model, prompt_version,
           generated_by_membership_id, now(), ${args.membershipId}
    FROM public.welcome_guides g
    WHERE g.tenant_id = ${args.tenantId} AND g.id = ${args.guideId}
    RETURNING id
  `;
  if (!ins) return fail("NOT_FOUND", "Guide not found");
  const after = await loadGuide(sql, args.tenantId, ins.id);
  return after ? { ok: true, guide: guideFromRow(after) } : fail("NOT_FOUND", "Guide not found");
}

// ─────────────────────────── resolution ───────────────────────────

export interface ResolvedWelcomeGuide {
  guideId: string;
  version: number;
  businessUnitId: string | null;
  scopeName: string | null;
  match: WelcomeScopeMatch;
  content: WelcomeGuideContent;
}

/** The published guide for a business unit: own → nearest ancestor → organisation. */
export async function resolveWelcomeGuideForBusinessUnit(
  sql: PgSqlClient,
  tenantId: string,
  businessUnitId: string | null,
): Promise<ResolvedWelcomeGuide | null> {
  const published = await sql<
    { id: string; business_unit_id: string | null; version: number; content: unknown }[]
  >`
    SELECT id, business_unit_id, version, content FROM public.welcome_guides
    WHERE tenant_id = ${tenantId} AND status = 'published'
  `;
  if (published.length === 0) return null;
  const bus = await sql<{ id: string; name: string; parent_business_unit_id: string | null }[]>`
    SELECT id, name, parent_business_unit_id FROM public.business_units
    WHERE tenant_id = ${tenantId}
  `;
  const parents = new Map(bus.map((b) => [b.id, b.parent_business_unit_id] as const));
  const names = new Map(bus.map((b) => [b.id, b.name] as const));
  const scope = resolveWelcomeScope({
    businessUnitId,
    parents,
    publishedBusinessUnitIds: new Set(
      published.map((p) => p.business_unit_id).filter((x): x is string => !!x),
    ),
    organisationPublished: published.some((p) => p.business_unit_id === null),
  });
  if (!scope) return null;
  const g = published.find((p) => p.business_unit_id === scope.businessUnitId);
  if (!g) return null;
  const content = welcomeGuideContentSchema.safeParse(g.content);
  return {
    guideId: g.id,
    version: g.version,
    businessUnitId: scope.businessUnitId,
    scopeName: scope.businessUnitId ? (names.get(scope.businessUnitId) ?? null) : null,
    match: scope.match,
    content: content.success ? content.data : welcomeGuideContentSchema.parse({}),
  };
}

export interface PreJoiningApplication {
  applicationId: string;
  businessUnitId: string | null;
  joiningDate: string | null;
  positionTitle: string | null;
}

const PRE_JOINING_APPLICATION_SELECT = (sql: PgSqlClient, tenantId: string) => sql`
  SELECT a.id AS application_id, pos.business_unit_id, pos.title AS position_title,
         o.joining_date::text AS joining_date, oc.status AS case_status
  FROM public.applications a
  JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
  JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
  JOIN public.positions pos ON pos.tenant_id = r.tenant_id AND pos.id = r.position_id
  JOIN LATERAL (
    SELECT joining_date, accepted_at FROM public.offers
    WHERE tenant_id = ${tenantId} AND application_id = a.id AND status = 'accepted'
    ORDER BY accepted_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  ) o ON true
  LEFT JOIN public.onboarding_cases oc ON oc.tenant_id = a.tenant_id AND oc.application_id = a.id
`;

interface PreJoiningRow {
  application_id: string;
  business_unit_id: string | null;
  position_title: string | null;
  joining_date: string | null;
  case_status: string | null;
}

function preJoiningFromRows(rows: PreJoiningRow[]): PreJoiningApplication | null {
  const r = rows.find(
    (x) => !caseStatusMeansJoined(x.case_status) && x.case_status !== "cancelled",
  );
  return r
    ? {
        applicationId: r.application_id,
        businessUnitId: r.business_unit_id,
        joiningDate: r.joining_date,
        positionTitle: r.position_title,
      }
    : null;
}

/**
 * The caller's pre-joining application: offer accepted (application at
 * offer_accepted with an accepted offer) and not yet joined / cancelled.
 * PERSON-SCOPED — this predicate is what keeps candidates apart.
 */
export async function resolvePreJoiningApplicationForPerson(
  sql: PgSqlClient,
  tenantId: string,
  personId: string,
): Promise<PreJoiningApplication | null> {
  const rows = await sql<PreJoiningRow[]>`
    ${PRE_JOINING_APPLICATION_SELECT(sql, tenantId)}
    WHERE a.tenant_id = ${tenantId} AND c.person_id = ${personId}
      AND a.current_stage = 'offer_accepted'
    ORDER BY o.accepted_at DESC NULLS LAST
  `;
  return preJoiningFromRows(rows);
}

/** Same rule for one application (the worker drain's check). */
export async function resolvePreJoiningApplication(
  sql: PgSqlClient,
  tenantId: string,
  applicationId: string,
): Promise<PreJoiningApplication | null> {
  const rows = await sql<PreJoiningRow[]>`
    ${PRE_JOINING_APPLICATION_SELECT(sql, tenantId)}
    WHERE a.tenant_id = ${tenantId} AND a.id = ${applicationId}
      AND a.current_stage = 'offer_accepted'
  `;
  return preJoiningFromRows(rows);
}

/** Published guide for one application's business unit (null if none / not pre-joining). */
export async function resolveWelcomeGuideForApplication(
  sql: PgSqlClient,
  tenantId: string,
  applicationId: string,
): Promise<ResolvedWelcomeGuide | null> {
  const app = await resolvePreJoiningApplication(sql, tenantId, applicationId);
  if (!app) return null;
  return resolveWelcomeGuideForBusinessUnit(sql, tenantId, app.businessUnitId);
}

// ─────────────────────────── candidate ───────────────────────────

export async function getCandidateWelcomeGuide(
  sql: PgSqlClient,
  args: { tenantId: string; personId: string; companyName: string },
): Promise<CandidateGetMyWelcomeGuideOutput> {
  const { tenantId, personId, companyName } = args;
  const app = await resolvePreJoiningApplicationForPerson(sql, tenantId, personId);
  if (!app) return { status: "not_pre_joining", companyName, guide: null };
  const resolved = await resolveWelcomeGuideForBusinessUnit(sql, tenantId, app.businessUnitId);
  if (!resolved) return { status: "no_guide", companyName, guide: null };

  // Photos + links are reference data from the CURRENT source (scope + org).
  const scopeSrc = (await loadWelcomeSource(sql, tenantId, resolved.businessUnitId)).source;
  const orgSrc = resolved.businessUnitId
    ? (await loadWelcomeSource(sql, tenantId, null)).source
    : null;
  const photos: Record<string, string> = {};
  for (const l of [...(orgSrc?.leaders ?? []), ...scopeSrc.leaders]) {
    if (l.photoUrl) photos[l.name] = l.photoUrl;
  }
  const links: WelcomeLink[] = [];
  const seenUrls = new Set<string>();
  for (const l of [...scopeSrc.links, ...(orgSrc?.links ?? [])]) {
    if (seenUrls.has(l.url)) continue;
    seenUrls.add(l.url);
    links.push(l);
  }
  const viewed = await sql<{ section: string }[]>`
    SELECT section FROM public.welcome_guide_views
    WHERE tenant_id = ${tenantId} AND guide_id = ${resolved.guideId}
      AND application_id = ${app.applicationId}
  `;
  return {
    status: "available",
    companyName,
    guide: {
      guideId: resolved.guideId,
      companyName,
      scopeName: resolved.scopeName,
      content: resolved.content,
      photos,
      links,
      sections: nonEmptyWelcomeSections(resolved.content),
      viewedSections: viewed
        .map((v) => welcomeGuideSectionKeySchema.safeParse(v.section))
        .filter((p) => p.success)
        .map((p) => p.data as WelcomeGuideSectionKey),
      joiningDate: app.joiningDate,
      positionTitle: app.positionTitle,
    },
  };
}

/**
 * Record that the candidate saw one section. Only the guide the candidate
 * would be shown right now is accepted (another BU's guide id, a superseded
 * version or a not-pre-joining caller → NOT_FOUND). Idempotent.
 */
export async function markWelcomeSectionViewed(
  sql: PgSqlClient,
  args: { tenantId: string; personId: string; guideId: string; section: WelcomeGuideSectionKey },
): Promise<WelcomeResult<object>> {
  const app = await resolvePreJoiningApplicationForPerson(sql, args.tenantId, args.personId);
  if (!app) return fail("NOT_FOUND", "Welcome guide not found");
  const resolved = await resolveWelcomeGuideForBusinessUnit(sql, args.tenantId, app.businessUnitId);
  if (!resolved || resolved.guideId !== args.guideId) {
    return fail("NOT_FOUND", "Welcome guide not found");
  }
  await sql`
    INSERT INTO public.welcome_guide_views (tenant_id, guide_id, application_id, section)
    VALUES (${args.tenantId}, ${args.guideId}, ${app.applicationId}, ${args.section})
    ON CONFLICT (tenant_id, guide_id, application_id, section) DO NOTHING
  `;
  return { ok: true };
}

/** For the PC-16 engagement timeline: one entry per guide version the candidate opened. */
export async function listWelcomeGuideViews(
  sql: PgSqlClient,
  tenantId: string,
  applicationId: string,
): Promise<{ guideId: string; version: number; firstViewedAt: string; sections: number }[]> {
  const rows = await sql<
    {
      guide_id: string;
      version: number;
      first_viewed_at: Date | string;
      sections: number | string;
    }[]
  >`
    SELECT v.guide_id, g.version, MIN(v.first_viewed_at) AS first_viewed_at,
           COUNT(DISTINCT v.section) AS sections
    FROM public.welcome_guide_views v
    JOIN public.welcome_guides g ON g.tenant_id = v.tenant_id AND g.id = v.guide_id
    WHERE v.tenant_id = ${tenantId} AND v.application_id = ${applicationId}
    GROUP BY v.guide_id, g.version
  `;
  return rows.map((r) => ({
    guideId: r.guide_id,
    version: r.version,
    firstViewedAt: iso(r.first_viewed_at) ?? "",
    sections: Number(r.sections),
  }));
}
