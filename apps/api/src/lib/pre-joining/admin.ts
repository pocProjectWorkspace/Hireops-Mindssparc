/**
 * PC-14 — admin side of pre-joining engagement: company updates (tenant
 * content the journey sends, next-unsent-first) and the "start journeys for
 * candidates who already accepted" backfill.
 */

import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import type { CompanyUpdateInput, CompanyUpdateRow } from "@hireops/api-types";
import { loadPreJoiningSettings, startPreJoiningJourney } from "./journey";

type PgSqlClient = typeof poolSql;

export async function listCompanyUpdates(
  sql: PgSqlClient,
  tenantId: string,
): Promise<CompanyUpdateRow[]> {
  const rows = await sql<
    {
      id: string;
      title: string;
      body: string;
      link_url: string | null;
      video_url: string | null;
      is_active: boolean;
      sort_order: number;
      sent_count: number | string;
      updated_at: Date | string;
    }[]
  >`
    SELECT u.id, u.title, u.body, u.link_url, u.video_url, u.is_active, u.sort_order, u.updated_at,
           (SELECT COUNT(*) FROM public.pre_joining_touchpoints tp
             WHERE tp.tenant_id = u.tenant_id AND tp.company_update_id = u.id
               AND tp.status = 'sent') AS sent_count
    FROM public.pre_joining_company_updates u
    WHERE u.tenant_id = ${tenantId}
    ORDER BY u.is_active DESC, u.sort_order, u.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    linkUrl: r.link_url,
    videoUrl: r.video_url,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    sentCount: Number(r.sent_count),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

/** Insert (no id) or update (id) one company update. Returns its id, or null if the id is not this tenant's. */
export async function upsertCompanyUpdate(
  sql: PgSqlClient,
  args: { tenantId: string; membershipId: string | null; input: CompanyUpdateInput },
): Promise<string | null> {
  const { tenantId, input } = args;
  if (input.id) {
    const rows = await sql<{ id: string }[]>`
      UPDATE public.pre_joining_company_updates
      SET title = ${input.title}, body = ${input.body}, link_url = ${input.linkUrl ?? null},
          video_url = ${input.videoUrl ?? null}, is_active = ${input.isActive},
          sort_order = ${input.sortOrder}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${input.id}
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.pre_joining_company_updates
      (tenant_id, title, body, link_url, video_url, is_active, sort_order, created_by_membership_id)
    VALUES (${tenantId}, ${input.title}, ${input.body}, ${input.linkUrl ?? null},
            ${input.videoUrl ?? null}, ${input.isActive}, ${input.sortOrder}, ${args.membershipId})
    RETURNING id
  `;
  return row?.id ?? null;
}

/** Start journeys now for every accepted-not-joined application without one. */
export async function startJourneysForAcceptedCandidates(
  sql: PgSqlClient,
  args: { tenantId: string; log: Logger },
): Promise<{ started: number; skipped: number }> {
  const settings = await loadPreJoiningSettings(sql, args.tenantId);
  if (!settings.enabled) return { started: 0, skipped: 0 };
  const apps = await sql<{ id: string }[]>`
    SELECT a.id FROM public.applications a
    WHERE a.tenant_id = ${args.tenantId} AND a.current_stage = 'offer_accepted'
      AND NOT EXISTS (
        SELECT 1 FROM public.pre_joining_journeys j
        WHERE j.tenant_id = a.tenant_id AND j.application_id = a.id
      )
    LIMIT 500
  `;
  let started = 0;
  let skipped = 0;
  for (const a of apps) {
    const r = await startPreJoiningJourney(sql, {
      tenantId: args.tenantId,
      applicationId: a.id,
      log: args.log,
      settings,
    });
    if (r.created) started += 1;
    else skipped += 1;
  }
  return { started, skipped };
}
