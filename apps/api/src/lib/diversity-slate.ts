/**
 * PC-26 — diverse-slate server helpers. The ONLY module that reads
 * candidate_diversity_self_id on behalf of staff, and it only ever returns
 * COUNTS per requisition.
 *
 * Why the service-role pool: the table's RLS admits candidate JWTs only, so a
 * recruiter's RLS client sees zero rows by design. The aggregate count below
 * therefore runs on the pool with an explicit tenant predicate, and its result
 * type has no room for a person id or a value. Callers must first prove the
 * requisition is visible to them through their own RLS client.
 *
 * Writes (candidate self-ID) are also here so the "prefer not to say is never
 * stored" and "one active answer per category" rules live in one place.
 *
 * Nothing in this module may be imported by scoring, evidence, export or any
 * AI prompt builder — test/pc26-diversity-slate-guardrails.test.ts checks.
 */

import {
  sql as poolSql,
  db as poolDb,
  tenants,
  candidateDiversitySelfId,
  type Database,
  type TenantBoundDb,
} from "@hireops/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
  normaliseDiversitySelfIdSubmission,
  computeDiverseSlateStatus,
  qualifyingSelfIdPairs,
  resolveDiversitySlateSettings,
  type DiverseSlateStatus,
  type DiversitySelfIdAnswer,
  type DiversitySelfIdSubmission,
  type DiversitySlateSettings,
} from "@hireops/api-types";

type PoolSql = typeof poolSql;

/**
 * Resolve the tenant's `diversitySlate` settings block. Never throws: a
 * missing tenant / malformed blob / DB hiccup resolves to the platform
 * default, which is DISABLED (collects nothing, flags nothing).
 */
export async function resolveTenantDiversitySlateDb(
  tenantId: string,
  client: typeof poolDb = poolDb,
): Promise<DiversitySlateSettings> {
  try {
    const [row] = await client
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    return resolveDiversitySlateSettings(settings["diversitySlate"]);
  } catch {
    return resolveDiversitySlateSettings(undefined);
  }
}

/**
 * Slate status for a set of requisitions in ONE tenant. Counts DISTINCT
 * persons whose application to the requisition sits in a counted stage AND
 * who hold at least one ACTIVE (not withdrawn) self-ID answer that the
 * tenant's categories mark as counting. Returns only aggregate numbers.
 */
export async function computeDiverseSlateStatuses(
  tenantId: string,
  requisitionIds: string[],
  settings: DiversitySlateSettings,
  sql: PoolSql = poolSql,
): Promise<Map<string, DiverseSlateStatus>> {
  const out = new Map<string, DiverseSlateStatus>();
  const ids = [...new Set(requisitionIds)];
  if (ids.length === 0) return out;

  const stages = settings.countedStages as string[];
  const pairs = qualifyingSelfIdPairs(settings);

  const rows = await sql<
    { id: string; required: boolean; min: number | null; qualifying: number }[]
  >`
    SELECT r.id::text AS id,
           r.diverse_slate_required AS required,
           r.diverse_slate_min AS min,
           (
             SELECT count(DISTINCT c.person_id)::int
             FROM public.applications a
             JOIN public.candidates c
               ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
             WHERE a.tenant_id = r.tenant_id
               AND a.requisition_id = r.id
               AND a.current_stage::text = ANY(${stages}::text[])
               AND EXISTS (
                 SELECT 1 FROM public.candidate_diversity_self_id d
                 WHERE d.tenant_id = a.tenant_id
                   AND d.person_id = c.person_id
                   AND d.withdrawn_at IS NULL
                   AND (d.category_key || ':' || d.value) = ANY(${pairs}::text[])
               )
           ) AS qualifying
    FROM public.requisitions r
    WHERE r.tenant_id = ${tenantId}::uuid
      AND r.id = ANY(${ids}::uuid[])
  `;

  for (const r of rows) {
    out.set(r.id, {
      requisitionId: r.id,
      ...computeDiverseSlateStatus({
        tenantEnabled: settings.enabled,
        required: r.required,
        roleMin: r.min,
        tenantDefaultMin: settings.defaultMin,
        qualifyingCount: Number(r.qualifying ?? 0),
      }),
    });
  }
  return out;
}

/** Status of one requisition (assumed already proven visible by the caller). */
export async function computeDiverseSlateStatus1(
  tenantId: string,
  requisitionId: string,
  settings?: DiversitySlateSettings,
): Promise<DiverseSlateStatus> {
  const s = settings ?? (await resolveTenantDiversitySlateDb(tenantId));
  const map = await computeDiverseSlateStatuses(tenantId, [requisitionId], s);
  return (
    map.get(requisitionId) ?? {
      requisitionId,
      status: "not_required",
      requiredMin: null,
      diverseInSlate: null,
    }
  );
}

// ─────────────────────────── candidate self-ID writes ───────────────────────────

export type SelfIdCollectedVia = "apply_form" | "candidate_portal";

/** Either the service pool (public apply form — no JWT) or the candidate's RLS tx. */
export type SelfIdDb = Database | TenantBoundDb;

/**
 * Apply a candidate's self-ID submission for one person. For each category:
 * withdraw the current active answer if it differs (or the candidate chose
 * "prefer not to say"), then insert the new answer if one was given.
 *
 * `db` is the candidate's own RLS transaction from the portal (the table's
 * policy admits candidate JWTs only) or the pool from the public apply form,
 * which has no JWT and has just resolved the person itself.
 *
 * `collectedVia: "apply_form"` is FILL-ONLY: the public form is
 * unauthenticated and links to an existing person by email / phone, so it may
 * add an answer for a category that has none but never changes or withdraws
 * an existing one. Changing / withdrawing happens only in the signed-in
 * candidate portal.
 *
 * No-op when the tenant has the feature off; throws when the disclosure
 * version doesn't match the copy currently served.
 */
export async function applySelfIdSubmission(
  db: SelfIdDb,
  params: {
    tenantId: string;
    personId: string;
    submission: DiversitySelfIdSubmission;
    settings: DiversitySlateSettings;
    collectedVia: SelfIdCollectedVia;
  },
): Promise<{ stored: number; withdrawn: number }> {
  const { tenantId, personId, submission, settings, collectedVia } = params;
  if (!settings.enabled) return { stored: 0, withdrawn: 0 };
  if (submission.disclosureVersion !== DIVERSITY_SELF_ID_DISCLOSURE_VERSION) {
    throw new Error("diversity_disclosure_version_mismatch");
  }
  const intents = normaliseDiversitySelfIdSubmission(submission, settings);
  let stored = 0;
  let withdrawn = 0;
  const fillOnly = collectedVia === "apply_form";
  for (const [categoryKey, value] of intents) {
    if (fillOnly && value === null) continue;
    const [cur] = await db
      .select({ id: candidateDiversitySelfId.id, value: candidateDiversitySelfId.value })
      .from(candidateDiversitySelfId)
      .where(
        and(
          eq(candidateDiversitySelfId.tenantId, tenantId),
          eq(candidateDiversitySelfId.personId, personId),
          eq(candidateDiversitySelfId.categoryKey, categoryKey),
          isNull(candidateDiversitySelfId.withdrawnAt),
        ),
      )
      .limit(1);
    if (cur && cur.value === value) continue; // unchanged
    if (cur && fillOnly) continue; // never overwrite from the unauthenticated form
    if (cur) {
      await db
        .update(candidateDiversitySelfId)
        .set({ withdrawnAt: new Date() })
        .where(
          and(
            eq(candidateDiversitySelfId.tenantId, tenantId),
            eq(candidateDiversitySelfId.id, cur.id),
          ),
        );
      withdrawn += 1;
    }
    if (value !== null) {
      await db.insert(candidateDiversitySelfId).values({
        tenantId,
        personId,
        categoryKey,
        value,
        disclosureVersion: submission.disclosureVersion,
        collectedVia,
      });
      stored += 1;
    }
  }
  return { stored, withdrawn };
}

/** The candidate's OWN active answers (category + value). Candidate-only read. */
export async function readOwnSelfId(
  db: SelfIdDb,
  tenantId: string,
  personId: string,
): Promise<DiversitySelfIdAnswer[]> {
  const rows = await db
    .select({
      categoryKey: candidateDiversitySelfId.categoryKey,
      value: candidateDiversitySelfId.value,
    })
    .from(candidateDiversitySelfId)
    .where(
      and(
        eq(candidateDiversitySelfId.tenantId, tenantId),
        eq(candidateDiversitySelfId.personId, personId),
        isNull(candidateDiversitySelfId.withdrawnAt),
      ),
    )
    .orderBy(candidateDiversitySelfId.categoryKey);
  return rows;
}
