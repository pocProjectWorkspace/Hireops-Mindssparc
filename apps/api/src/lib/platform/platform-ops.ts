/**
 * C1-F10 — platform console reads + writes (Plan A §14.4).
 *
 * METADATA ONLY (D2). Every query here touches the tenant registry, membership
 * / identity COUNTS, module entitlements, queue COUNTS and the worker
 * heartbeat table. Nothing reads a candidate, requisition, application,
 * interview or offer column beyond `count(*)` grouped by tenant — the console
 * cannot show tenant content because these functions never select it.
 *
 * All reads/writes go through the service-role pool: platform operators have
 * no tenant, so there is no tenant transaction to open. Writes append a
 * platform_audit_log row in the SAME transaction as the change.
 */

import type { sql as poolSql } from "@hireops/db";
import {
  PLATFORM_MODULE_KEYS,
  PLATFORM_MODULE_LABELS,
  PLATFORM_QUEUE_KEYS,
  isPlatformModuleKey,
  type PlatformGetHealthOutput,
  type PlatformGetTenantOutput,
  type PlatformModuleKey,
  type PlatformQueueKey,
  type PlatformTenantSummary,
  type TenantStatus,
} from "@hireops/api-types";

type SqlHandle = typeof poolSql;

/** Requisition statuses that count as "active" in the registry. */
const ACTIVE_REQ_STATUSES = ["pending_approval", "approved", "posted", "on_hold"];

export interface PlatformActor {
  operatorId: string | null;
  email: string;
  requestId: string | null;
}

/** Append one platform_audit_log row. `summary` must hold metadata only. */
export async function writePlatformAudit(
  sql: SqlHandle,
  actor: PlatformActor,
  action: string,
  tenantId: string | null,
  summary: Record<string, unknown>,
): Promise<void> {
  await sql`
    INSERT INTO public.platform_audit_log
      (operator_id, operator_email, action, tenant_id, summary, request_id)
    VALUES (${actor.operatorId}, ${actor.email}, ${action}, ${tenantId},
            ${JSON.stringify(summary)}::jsonb, ${actor.requestId})
  `;
}

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  tier: string;
  primary_region: string;
  onboarding_status: string;
  created_at: Date;
  activated_at: Date | null;
  suspended_at: Date | null;
  scheduled_deletion_at: Date | null;
  active_members: number;
  active_requisitions: number;
  partner_users: number;
  candidate_accounts: number;
  disabled_modules: string[] | null;
}

async function loadTenantRows(sql: SqlHandle, tenantId: string | null): Promise<TenantRow[]> {
  return sql<TenantRow[]>`
    SELECT t.id::text AS id, t.slug, t.display_name, t.status, t.tier, t.primary_region,
           t.onboarding_status, t.created_at, t.activated_at, t.suspended_at,
           t.scheduled_deletion_at,
           COALESCE(m.n, 0)::int AS active_members,
           COALESCE(r.n, 0)::int AS active_requisitions,
           COALESCE(pu.n, 0)::int AS partner_users,
           COALESCE(ca.n, 0)::int AS candidate_accounts,
           dm.keys AS disabled_modules
      FROM public.tenants t
      LEFT JOIN (SELECT tenant_id, count(*) AS n FROM public.tenant_user_memberships
                  WHERE status = 'active' GROUP BY tenant_id) m ON m.tenant_id = t.id
      LEFT JOIN (SELECT tenant_id, count(*) AS n FROM public.requisitions
                  WHERE status = ANY(${ACTIVE_REQ_STATUSES}::text[]) GROUP BY tenant_id) r
             ON r.tenant_id = t.id
      LEFT JOIN (SELECT tenant_id, count(*) AS n FROM public.partner_users
                  WHERE active = true GROUP BY tenant_id) pu ON pu.tenant_id = t.id
      LEFT JOIN (SELECT tenant_id, count(*) AS n FROM public.candidate_accounts
                  WHERE status = 'active' GROUP BY tenant_id) ca ON ca.tenant_id = t.id
      LEFT JOIN (SELECT tenant_id, array_agg(module_key ORDER BY module_key) AS keys
                   FROM public.tenant_modules WHERE enabled = false GROUP BY tenant_id) dm
             ON dm.tenant_id = t.id
     WHERE ${tenantId === null ? sql`true` : sql`t.id = ${tenantId}`}
     ORDER BY t.display_name, t.slug
  `;
}

function toSummary(r: TenantRow): PlatformTenantSummary {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    status: r.status,
    tier: r.tier,
    primaryRegion: r.primary_region,
    createdAt: iso(r.created_at) as string,
    activatedAt: iso(r.activated_at),
    suspendedAt: iso(r.suspended_at),
    activeMembers: r.active_members,
    activeRequisitions: r.active_requisitions,
    disabledModules: (r.disabled_modules ?? []).filter(isPlatformModuleKey),
  };
}

export async function listTenantsForPlatform(sql: SqlHandle): Promise<PlatformTenantSummary[]> {
  return (await loadTenantRows(sql, null)).map(toSummary);
}

export async function getTenantForPlatform(
  sql: SqlHandle,
  tenantId: string,
): Promise<PlatformGetTenantOutput | null> {
  const [row] = await loadTenantRows(sql, tenantId);
  if (!row) return null;

  const moduleRows = await sql<
    { module_key: string; enabled: boolean; enabled_at: Date | null; updated_at: Date }[]
  >`
    SELECT module_key, enabled, enabled_at, updated_at
      FROM public.tenant_modules WHERE tenant_id = ${tenantId}
  `;
  const byKey = new Map(moduleRows.map((m) => [m.module_key, m] as const));
  const modules = PLATFORM_MODULE_KEYS.map((key) => {
    const m = byKey.get(key);
    return {
      key,
      label: PLATFORM_MODULE_LABELS[key],
      enabled: m ? m.enabled : true,
      explicit: Boolean(m),
      changedAt: m ? iso(m.updated_at) : null,
    };
  });

  const audit = await sql<
    { id: string; operator_email: string; action: string; summary: unknown; created_at: Date }[]
  >`
    SELECT id::text AS id, operator_email, action, summary, created_at
      FROM public.platform_audit_log
     WHERE tenant_id = ${tenantId} AND action <> 'tenant.view'
     ORDER BY created_at DESC
     LIMIT 20
  `;

  return {
    tenant: {
      ...toSummary(row),
      onboardingStatus: row.onboarding_status,
      scheduledDeletionAt: iso(row.scheduled_deletion_at),
      partnerUsers: row.partner_users,
      candidateAccounts: row.candidate_accounts,
    },
    modules,
    recentAudit: audit.map((a) => ({
      id: a.id,
      operatorEmail: a.operator_email,
      action: a.action,
      summary: (a.summary ?? {}) as Record<string, unknown>,
      createdAt: iso(a.created_at) as string,
    })),
  };
}

export type SetTenantStatusResult =
  | { ok: true; previousStatus: string }
  | { ok: false; reason: "not_found" };

/**
 * Move a tenant to a lifecycle state. Stamps activated_at on first activation
 * and suspended_at on suspension (cleared on reactivation). Audited with the
 * operator's reason. Idempotent: setting the current status still audits (an
 * operator re-confirming a suspension is itself a fact worth recording).
 */
export async function setTenantStatus(
  sql: SqlHandle,
  actor: PlatformActor,
  tenantId: string,
  status: TenantStatus,
  reason: string,
): Promise<SetTenantStatusResult> {
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as SqlHandle;
    const [cur] = await txSql<{ status: string }[]>`
      SELECT status FROM public.tenants WHERE id = ${tenantId} FOR UPDATE
    `;
    if (!cur) return { ok: false, reason: "not_found" } as const;
    await txSql`
      UPDATE public.tenants
         SET status = ${status},
             activated_at = CASE WHEN ${status} = 'active' THEN COALESCE(activated_at, now())
                                 ELSE activated_at END,
             suspended_at = CASE WHEN ${status} = 'suspended' THEN now()
                                 WHEN ${status} = 'active' THEN NULL
                                 ELSE suspended_at END
       WHERE id = ${tenantId}
    `;
    await writePlatformAudit(txSql, actor, "tenant.status_change", tenantId, {
      from: cur.status,
      to: status,
      reason,
    });
    return { ok: true, previousStatus: cur.status } as const;
  });
}

export type SetTenantModulesResult =
  | { ok: true; changed: { key: PlatformModuleKey; enabled: boolean }[] }
  | { ok: false; reason: "not_found" };

/** Upsert module entitlements for a tenant; audits only the keys whose value changed. */
export async function setTenantModules(
  sql: SqlHandle,
  actor: PlatformActor,
  tenantId: string,
  modules: { key: PlatformModuleKey; enabled: boolean }[],
  reason: string | undefined,
): Promise<SetTenantModulesResult> {
  return sql.begin(async (tx) => {
    const txSql = tx as unknown as SqlHandle;
    const [t] = await txSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE id = ${tenantId} FOR UPDATE
    `;
    if (!t) return { ok: false, reason: "not_found" } as const;

    const existing = await txSql<{ module_key: string; enabled: boolean }[]>`
      SELECT module_key, enabled FROM public.tenant_modules WHERE tenant_id = ${tenantId}
    `;
    const current = new Map(existing.map((e) => [e.module_key, e.enabled] as const));

    // Last write wins if the same key appears twice in one request.
    const desired = new Map(modules.map((m) => [m.key, m.enabled] as const));
    const changed: { key: PlatformModuleKey; enabled: boolean }[] = [];
    for (const [key, enabled] of desired) {
      const before = current.has(key) ? current.get(key) : true; // missing row = enabled
      if (before === enabled) continue; // no effective change → no write, no audit
      await txSql`
        INSERT INTO public.tenant_modules
          (tenant_id, module_key, enabled, enabled_at, enabled_by_operator, updated_at)
        VALUES (${tenantId}, ${key}, ${enabled}, ${enabled ? txSql`now()` : null},
                ${actor.operatorId}, now())
        ON CONFLICT (tenant_id, module_key) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              enabled_at = CASE WHEN EXCLUDED.enabled AND NOT public.tenant_modules.enabled
                                THEN now() ELSE public.tenant_modules.enabled_at END,
              enabled_by_operator = EXCLUDED.enabled_by_operator,
              updated_at = now()
      `;
      changed.push({ key, enabled });
    }
    if (changed.length > 0) {
      await writePlatformAudit(txSql, actor, "tenant.modules_change", tenantId, {
        changes: changed,
        ...(reason ? { reason } : {}),
      });
    }
    return { ok: true, changed } as const;
  });
}

interface QueueSpec {
  table: string;
  backlog: string;
  failed: string;
  ts: string;
}

// Hard-coded identifiers only (no user input reaches these fragments).
const QUEUES: Record<PlatformQueueKey, QueueSpec> = {
  notification_outbox: {
    table: "notification_outbox",
    backlog: "status IN ('pending', 'processing')",
    failed: "status = 'failed'",
    ts: "created_at",
  },
  ai_score_outbox: {
    table: "ai_score_outbox",
    backlog: "status IN ('pending', 'processing')",
    failed: "status = 'failed'",
    ts: "created_at",
  },
  transcript_outbox: {
    table: "transcript_outbox",
    backlog: "status IN ('pending', 'processing')",
    failed: "status = 'failed'",
    ts: "created_at",
  },
  agent_run_outbox: {
    table: "agent_run_outbox",
    backlog: "status IN ('pending', 'processing')",
    failed: "status = 'failed'",
    ts: "enqueued_at",
  },
  workday_sync_outbox: {
    table: "workday_sync_outbox",
    backlog: "status IN ('pending', 'processing')",
    failed: "status = 'failed'",
    ts: "created_at",
  },
  bulk_cv_items: {
    table: "bulk_cv_items",
    backlog: "status IN ('queued', 'parsing')",
    failed: "status = 'failed'",
    ts: "created_at",
  },
  pre_joining_touchpoints: {
    table: "pre_joining_touchpoints",
    backlog: "(status = 'scheduled' AND scheduled_for <= now()) OR status = 'processing'",
    failed: "status = 'failed'",
    ts: "created_at",
  },
  ai_interview_evidence: {
    table: "ai_interview_evidence",
    backlog: "status IN ('pending', 'processing')",
    failed: "status = 'failed'",
    ts: "created_at",
  },
};

/**
 * Cross-tenant queue health: per tenant per queue, backlog count, failures in
 * the last 7 days and the oldest backlog timestamp — COUNTS ONLY. Plus the
 * worker scheduled-job heartbeat (scheduled_job_runs), which is platform-wide.
 */
export async function getPlatformHealth(sql: SqlHandle): Promise<PlatformGetHealthOutput> {
  const tenants = await sql<{ id: string; slug: string; display_name: string; status: string }[]>`
    SELECT id::text AS id, slug, display_name, status FROM public.tenants
     ORDER BY display_name, slug
  `;

  const parts = PLATFORM_QUEUE_KEYS.map((key) => {
    const q = QUEUES[key];
    return `SELECT '${key}' AS queue, tenant_id::text AS tenant_id,
              count(*) FILTER (WHERE ${q.backlog})::int AS backlog,
              count(*) FILTER (WHERE ${q.failed} AND ${q.ts} >= now() - interval '7 days')::int AS failed_7d,
              min(${q.ts}) FILTER (WHERE ${q.backlog}) AS oldest_backlog_at
         FROM public.${q.table}
        WHERE (${q.backlog}) OR (${q.failed} AND ${q.ts} >= now() - interval '7 days')
        GROUP BY tenant_id`;
  });
  const rows = await sql.unsafe<
    {
      queue: PlatformQueueKey;
      tenant_id: string;
      backlog: number;
      failed_7d: number;
      oldest_backlog_at: Date | null;
    }[]
  >(parts.join("\nUNION ALL\n"));

  const byTenant = new Map<string, Map<PlatformQueueKey, (typeof rows)[number]>>();
  for (const r of rows) {
    const m = byTenant.get(r.tenant_id) ?? new Map();
    m.set(r.queue, r);
    byTenant.set(r.tenant_id, m);
  }

  const jobs = await sql<
    {
      job_name: string;
      last_run_at: Date;
      last_run_status: string;
      last_run_duration_ms: number | null;
    }[]
  >`
    SELECT job_name, last_run_at, last_run_status, last_run_duration_ms
      FROM public.scheduled_job_runs ORDER BY job_name
  `;

  return {
    generatedAt: new Date().toISOString(),
    tenants: tenants.map((t) => {
      const m = byTenant.get(t.id);
      return {
        tenantId: t.id,
        slug: t.slug,
        displayName: t.display_name,
        status: t.status,
        queues: PLATFORM_QUEUE_KEYS.map((queue) => {
          const r = m?.get(queue);
          return {
            queue,
            backlog: r?.backlog ?? 0,
            failed7d: r?.failed_7d ?? 0,
            oldestBacklogAt: iso(r?.oldest_backlog_at ?? null),
          };
        }),
      };
    }),
    jobs: jobs.map((j) => ({
      jobName: j.job_name,
      lastRunAt: iso(j.last_run_at) as string,
      lastRunStatus: j.last_run_status,
      lastRunDurationMs: j.last_run_duration_ms,
    })),
  };
}

/**
 * The sign-in doors' lifecycle check for ONE auth user: are they a platform
 * operator, and does any identity of the given audience sit in an active
 * tenant? Reveals only the caller's own tenant status.
 */
export async function getAccountAccess(
  sql: SqlHandle,
  userId: string,
  audience: "internal" | "partner" | "candidate",
): Promise<{ platformOperator: boolean; statuses: string[] }> {
  const [op] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.platform_operators
     WHERE user_id = ${userId} AND active = true
  `;
  const statuses =
    audience === "internal"
      ? await sql<{ status: string }[]>`
          SELECT t.status FROM public.tenant_user_memberships m
            JOIN public.tenants t ON t.id = m.tenant_id
           WHERE m.user_id = ${userId} AND m.status = 'active'`
      : audience === "partner"
        ? await sql<{ status: string }[]>`
            SELECT t.status FROM public.partner_users pu
              JOIN public.tenants t ON t.id = pu.tenant_id
             WHERE pu.user_id = ${userId} AND pu.active = true`
        : await sql<{ status: string }[]>`
            SELECT t.status FROM public.candidate_accounts ca
              JOIN public.tenants t ON t.id = ca.tenant_id
             WHERE ca.user_id = ${userId} AND ca.status = 'active'`;
  return { platformOperator: (op?.n ?? 0) > 0, statuses: statuses.map((s) => s.status) };
}
