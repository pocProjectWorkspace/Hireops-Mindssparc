/**
 * C2-F7 / PP20 — CV / talent-pool retention REGISTER.
 *
 * Lists candidates whose CV has been held longer than the tenant's
 * `retentionPolicy.talentPoolRetentionMonths` (default 24, platform ceiling
 * 60) since their LAST application activity. A register, not an automation:
 * nothing is deleted or anonymised here or in the worker scan
 * (apps/workers jobs/cv-retention-scan.ts) — erasure is a later decision.
 *
 * Definition:
 *   last activity = the latest `applications.updated_at` across the
 *                   candidate's applications, else `candidates.created_at`;
 *   excluded      = candidates with an application at offer_accepted (they
 *                   became employees — employee records follow a different
 *                   retention).
 */

import { sql as dsql } from "drizzle-orm";
import { resolveRetentionPolicy, type ListCvsPastRetentionOutput } from "@hireops/api-types";

interface Exec {
  execute: (q: ReturnType<typeof dsql>) => Promise<unknown>;
}

function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

/** The SQL predicate body shared by the register and the worker scan. */
export function cvPastRetentionSql(tenantId: string, months: number) {
  return dsql`
    WITH activity AS (
      SELECT
        c.id AS candidate_id,
        c.person_id,
        COALESCE(MAX(a.updated_at), c.created_at) AS last_activity_at,
        COUNT(a.id)::int AS application_count,
        BOOL_OR(a.current_stage = 'offer_accepted') AS hired
      FROM public.candidates c
      LEFT JOIN public.applications a
        ON a.tenant_id = c.tenant_id AND a.candidate_id = c.id
      WHERE c.tenant_id = ${tenantId}::uuid
      GROUP BY c.id, c.person_id, c.created_at
    )
    SELECT
      act.candidate_id::text AS candidate_id,
      p.full_name AS full_name,
      act.last_activity_at AS last_activity_at,
      act.application_count AS application_count
    FROM activity act
    JOIN public.persons p ON p.tenant_id = ${tenantId}::uuid AND p.id = act.person_id
    WHERE COALESCE(act.hired, false) = false
      AND act.last_activity_at < now() - make_interval(months => ${months}::int)
  `;
}

const REGISTER_LIMIT = 500;

export async function listCvsPastRetention(
  db: Exec,
  tenantId: string,
  tenantSettings: unknown,
  now: Date = new Date(),
): Promise<ListCvsPastRetentionOutput> {
  const settings =
    tenantSettings && typeof tenantSettings === "object"
      ? (tenantSettings as Record<string, unknown>)
      : {};
  const months = resolveRetentionPolicy(settings.retentionPolicy).talentPoolRetentionMonths;
  const res = await db.execute(dsql`
    ${cvPastRetentionSql(tenantId, months)}
    ORDER BY act.last_activity_at ASC
  `);
  const rows = asRows<{
    candidate_id: string;
    full_name: string | null;
    last_activity_at: Date | string;
    application_count: number;
  }>(res);
  const items = rows.slice(0, REGISTER_LIMIT).map((r) => {
    const at =
      r.last_activity_at instanceof Date ? r.last_activity_at : new Date(r.last_activity_at);
    const ageMonths = Math.max(
      0,
      (now.getUTCFullYear() - at.getUTCFullYear()) * 12 + (now.getUTCMonth() - at.getUTCMonth()),
    );
    return {
      candidateId: r.candidate_id,
      fullName: r.full_name,
      lastActivityAt: at.toISOString(),
      ageMonths,
      applicationCount: Number(r.application_count) || 0,
    };
  });
  return { retentionMonths: months, total: rows.length, items };
}
