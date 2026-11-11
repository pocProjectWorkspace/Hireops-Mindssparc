/**
 * C1-F11 — tenant provisioning (Plan A §14.3 steps 1–2).
 *
 * An idempotent, resumable job. platformCreateTenant inserts the tenant row
 * (status `provisioning`) and its tenant_provisioning_jobs row in one
 * transaction, then runs the steps in order:
 *
 *   tenant_row        → (done at create) the registry row, status provisioning
 *   encryption_key    → a real per-tenant DEK wrapped by the KMS master key
 *                       (the FND-15d envelope; replaces the seed scripts'
 *                       placeholder-DEK pattern — a placeholder row, if any,
 *                       is upgraded, a real one is kept)
 *   modules           → explicit tenant_modules rows: pack recommendation +
 *                       operator overrides, one row per catalogue module
 *   starter_pack      → the pack's configuration applied ADDITIVELY through
 *                       the config-import applier (one transaction, tenant
 *                       audit on every row), plus settings.starterPack
 *   admin_invite      → the first admin invited through the AuthAdminPort
 *                       (user_metadata.tenant_slug for the access-token hook)
 *   admin_membership  → membership with the admin role (+ profile row)
 *   activate          → status provisioning → active
 *
 * Every step records itself in `steps` when it completes; a run skips steps
 * already done, so re-running never duplicates anything and never invites
 * twice. A failure marks the job `failed` with the error; platformRetryProvisioning
 * resumes at the failed step. Every step is written to platform_audit_log.
 */

import type { sql as poolSql } from "@hireops/db";
import { generateDek, getKmsClient, wrapDek, type KmsClient } from "@hireops/db";
import {
  PLATFORM_MODULE_KEYS,
  PROVISIONING_STEPS,
  PROVISIONING_STEP_LABELS,
  getStarterPack,
  type PlatformModuleKey,
  type ProvisioningJobStatus,
  type ProvisioningStatus,
  type ProvisioningStepKey,
  type StarterPack,
  type TenantTier,
} from "@hireops/api-types";
import { writePlatformAudit, type PlatformActor } from "./platform-ops";
import { invalidateTenantAccessCache } from "./tenant-access";
import type { AuthAdminPort } from "./auth-admin-port";
import { applyTenantConfig, withConfigTx } from "../tenant-config/config-io";

type SqlHandle = typeof poolSql;
type Json = Record<string, unknown>;

export interface ProvisioningActor extends PlatformActor {
  /** The operator's auth user id — recorded as the actor on tenant audit rows. */
  userId: string | null;
}

export interface ProvisioningDeps {
  sql: SqlHandle;
  authAdmin: AuthAdminPort;
  /** Defaults to getKmsClient() (KMS_PROVIDER / SUPABASE_KEK_SECRET). */
  kms?: KmsClient;
  actor: ProvisioningActor;
}

/** What a retry needs, kept on the job row. Never a secret. */
interface ProvisioningRequest {
  tier: TenantTier;
  primaryRegion: string;
  modules: { key: PlatformModuleKey; enabled: boolean }[];
  adminEmail: string;
  adminDisplayName: string | null;
}

interface JobRow {
  tenant_id: string;
  status: ProvisioningJobStatus;
  starter_pack_key: string;
  starter_pack_version: number;
  request: ProvisioningRequest;
  steps: Record<string, { status: string; at?: string; detail?: Json; error?: string }>;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

/** A running job whose heartbeat is older than this is considered abandoned. */
const STALE_RUNNING = "5 minutes";
const PLACEHOLDER_KMS_RE = /^placeholder/i;

export class ProvisioningError extends Error {
  constructor(
    readonly code: "slug_taken" | "unknown_pack" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export interface CreateTenantRequest {
  slug: string;
  displayName: string;
  primaryRegion: string;
  tier: TenantTier;
  starterPack: string;
  modules: { key: PlatformModuleKey; enabled: boolean }[];
  adminEmail: string;
  adminDisplayName?: string | undefined;
}

/**
 * Create the tenant row + job row (one transaction), then run the job.
 * Returns the tenant id; the run's outcome is in the job status.
 */
export async function createTenantAndProvision(
  deps: ProvisioningDeps,
  input: CreateTenantRequest,
): Promise<string> {
  const pack = getStarterPack(input.starterPack);
  if (!pack)
    throw new ProvisioningError("unknown_pack", `unknown starter pack: ${input.starterPack}`);
  const { sql, actor } = deps;

  const tenantId = await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as SqlHandle;
    const [taken] = await tx<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${input.slug}
    `;
    if (taken) throw new ProvisioningError("slug_taken", `slug already in use: ${input.slug}`);
    const [t] = await tx<{ id: string }[]>`
      INSERT INTO public.tenants
        (slug, display_name, primary_region, status, tier, onboarding_status, settings)
      VALUES (${input.slug}, ${input.displayName}, ${input.primaryRegion}, 'provisioning',
              ${input.tier}, 'in_progress', '{}'::jsonb)
      RETURNING id::text AS id
    `;
    if (!t) throw new Error("tenant insert returned no row");
    const request: ProvisioningRequest = {
      tier: input.tier,
      primaryRegion: input.primaryRegion,
      modules: input.modules,
      adminEmail: input.adminEmail,
      adminDisplayName: input.adminDisplayName ?? null,
    };
    const steps = {
      tenant_row: { status: "done", at: new Date().toISOString(), detail: { slug: input.slug } },
    };
    await tx`
      INSERT INTO public.tenant_provisioning_jobs
        (tenant_id, status, starter_pack_key, starter_pack_version, request, steps, created_by_operator)
      VALUES (${t.id}, 'pending', ${pack.key}, ${pack.version}, ${JSON.stringify(request)}::jsonb,
              ${JSON.stringify(steps)}::jsonb, ${actor.operatorId})
    `;
    await writePlatformAudit(tx, actor, "tenant.create", t.id, {
      slug: input.slug,
      starterPack: pack.key,
      starterPackVersion: pack.version,
      tier: input.tier,
      primaryRegion: input.primaryRegion,
    });
    return t.id;
  });

  await runProvisioning(deps, tenantId);
  return tenantId;
}

async function loadJob(sql: SqlHandle, tenantId: string): Promise<JobRow | null> {
  const [j] = await sql<JobRow[]>`
    SELECT tenant_id::text AS tenant_id, status, starter_pack_key, starter_pack_version, request,
           steps, attempts, last_error, created_at, completed_at
      FROM public.tenant_provisioning_jobs WHERE tenant_id = ${tenantId}
  `;
  return j ?? null;
}

async function markStep(
  sql: SqlHandle,
  tenantId: string,
  step: ProvisioningStepKey,
  value: Json,
): Promise<void> {
  await sql`
    UPDATE public.tenant_provisioning_jobs
       SET steps = steps || jsonb_build_object(${step}::text, ${JSON.stringify(value)}::jsonb),
           updated_at = now()
     WHERE tenant_id = ${tenantId}
  `;
}

/**
 * Run (or resume) the job. Claims it first so two concurrent runs cannot both
 * work it; a completed job, or one another caller is running, is left alone.
 */
export async function runProvisioning(deps: ProvisioningDeps, tenantId: string): Promise<void> {
  const { sql, actor } = deps;
  const claimed = await sql<{ tenant_id: string }[]>`
    UPDATE public.tenant_provisioning_jobs
       SET status = 'running', attempts = attempts + 1, last_error = NULL, updated_at = now()
     WHERE tenant_id = ${tenantId}
       AND (status IN ('pending', 'failed')
            OR (status = 'running' AND updated_at < now() - ${STALE_RUNNING}::interval))
    RETURNING tenant_id
  `;
  if (claimed.length === 0) return;

  const job = await loadJob(sql, tenantId);
  if (!job) throw new ProvisioningError("not_found", "provisioning job not found");
  const pack = getStarterPack(job.starter_pack_key);

  for (const step of PROVISIONING_STEPS) {
    const prev = job.steps[step];
    if (prev?.status === "done") continue;
    try {
      if (!pack) throw new Error(`starter pack no longer available: ${job.starter_pack_key}`);
      if (pack.version !== job.starter_pack_version && step === "starter_pack") {
        // The pack was re-released mid-provisioning; apply the job's version only.
        throw new Error(
          `starter pack ${pack.key} is now version ${pack.version}; this job was created for version ${job.starter_pack_version}`,
        );
      }
      const detail = await runStep(deps, step, tenantId, job, pack);
      const done = { status: "done", at: new Date().toISOString(), detail };
      job.steps[step] = done;
      await markStep(sql, tenantId, step, done);
      await writePlatformAudit(sql, actor, "tenant.provision.step", tenantId, { step, ...detail });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1900);
      await markStep(sql, tenantId, step, {
        status: "failed",
        at: new Date().toISOString(),
        error: message,
      });
      await sql`
        UPDATE public.tenant_provisioning_jobs
           SET status = 'failed', last_error = ${message}, updated_at = now()
         WHERE tenant_id = ${tenantId}
      `;
      await writePlatformAudit(sql, actor, "tenant.provision.failed", tenantId, {
        step,
        error: message,
      });
      return;
    }
  }

  await sql`
    UPDATE public.tenant_provisioning_jobs
       SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE tenant_id = ${tenantId}
  `;
  await writePlatformAudit(sql, actor, "tenant.provision.completed", tenantId, {
    starterPack: job.starter_pack_key,
    starterPackVersion: job.starter_pack_version,
  });
}

async function runStep(
  deps: ProvisioningDeps,
  step: ProvisioningStepKey,
  tenantId: string,
  job: JobRow,
  pack: StarterPack,
): Promise<Json> {
  const { sql, actor } = deps;
  const [tenant] = await sql<{ slug: string; display_name: string; status: string }[]>`
    SELECT slug, display_name, status FROM public.tenants WHERE id = ${tenantId}
  `;
  if (!tenant) throw new Error("tenant row missing");

  switch (step) {
    case "tenant_row":
      return { slug: tenant.slug };

    case "encryption_key": {
      const [existing] = await sql<{ kms_key_id: string }[]>`
        SELECT kms_key_id FROM public.tenant_encryption_keys WHERE tenant_id = ${tenantId}
      `;
      if (existing && !PLACEHOLDER_KMS_RE.test(existing.kms_key_id)) {
        return { kmsKeyId: existing.kms_key_id, reused: true };
      }
      const kms = deps.kms ?? getKmsClient();
      const wrapped = await wrapDek(generateDek(), kms);
      await sql`
        INSERT INTO public.tenant_encryption_keys (tenant_id, encrypted_dek, kms_key_id)
        VALUES (${tenantId}, ${Buffer.from(wrapped.encryptedDek)}, ${wrapped.kmsKeyId})
        ON CONFLICT (tenant_id) DO UPDATE
          SET encrypted_dek = EXCLUDED.encrypted_dek, kms_key_id = EXCLUDED.kms_key_id,
              rotated_at = now()
          WHERE public.tenant_encryption_keys.kms_key_id LIKE 'placeholder%'
      `;
      return { kmsKeyId: wrapped.kmsKeyId, reused: false, upgradedPlaceholder: Boolean(existing) };
    }

    case "modules": {
      const overrides = new Map(job.request.modules.map((m) => [m.key, m.enabled] as const));
      const disabled: string[] = [];
      await sql.begin(async (rawTx) => {
        const tx = rawTx as unknown as SqlHandle;
        for (const key of PLATFORM_MODULE_KEYS) {
          const enabled = overrides.get(key) ?? pack.modules[key] ?? true;
          if (!enabled) disabled.push(key);
          await tx`
            INSERT INTO public.tenant_modules
              (tenant_id, module_key, enabled, enabled_at, enabled_by_operator, updated_at)
            VALUES (${tenantId}, ${key}, ${enabled}, ${enabled ? tx`now()` : null},
                    ${actor.operatorId}, now())
            ON CONFLICT (tenant_id, module_key) DO NOTHING
          `;
        }
      });
      invalidateTenantAccessCache(tenantId);
      return { disabled };
    }

    case "starter_pack": {
      const result = await withConfigTx(
        sql,
        { userId: actor.userId, requestId: actor.requestId, source: "system" },
        async (tx) => {
          const applied = await applyTenantConfig(tx, tenantId, pack.config, "additive");
          const marker = {
            key: pack.key,
            version: pack.version,
            appliedAt: new Date().toISOString(),
          };
          await tx`
            UPDATE public.tenants
               SET settings = COALESCE(settings, '{}'::jsonb)
                              || jsonb_build_object('starterPack', ${JSON.stringify(marker)}::jsonb)
             WHERE id = ${tenantId} AND NOT (COALESCE(settings, '{}'::jsonb) ? 'starterPack')
          `;
          return applied;
        },
      );
      const adds: Record<string, number> = {};
      for (const d of result.diff) if (d.adds.length > 0) adds[d.section] = d.adds.length;
      return {
        starterPack: pack.key,
        starterPackVersion: pack.version,
        adds,
        ...(result.skipped.length ? { skipped: result.skipped } : {}),
      };
    }

    case "admin_invite": {
      const meta: Record<string, string> = { tenant_slug: tenant.slug };
      if (job.request.adminDisplayName) meta.display_name = job.request.adminDisplayName;
      const res = await deps.authAdmin.inviteUser(job.request.adminEmail, meta);
      return { userId: res.userId, alreadyExisted: res.alreadyExisted };
    }

    case "admin_membership": {
      const userId = job.steps.admin_invite?.detail?.userId;
      if (typeof userId !== "string") throw new Error("admin invite has no user id");
      await sql`
        INSERT INTO public.users (id, display_name)
        VALUES (${userId}, ${job.request.adminDisplayName})
        ON CONFLICT (id) DO NOTHING
      `;
      const [m] = await sql<{ id: string }[]>`
        INSERT INTO public.tenant_user_memberships (user_id, tenant_id, roles, status, invited_at)
        VALUES (${userId}, ${tenantId}, '{admin}', 'active', now())
        ON CONFLICT (user_id, tenant_id) DO UPDATE
          SET roles = CASE WHEN 'admin' = ANY(public.tenant_user_memberships.roles)
                           THEN public.tenant_user_memberships.roles
                           ELSE array_append(public.tenant_user_memberships.roles, 'admin') END,
              status = 'active', updated_at = now()
        RETURNING id::text AS id
      `;
      return { membershipId: m?.id ?? null, userId };
    }

    case "activate": {
      const res = await sql<{ id: string }[]>`
        UPDATE public.tenants
           SET status = 'active', activated_at = COALESCE(activated_at, now())
         WHERE id = ${tenantId} AND status = 'provisioning'
        RETURNING id
      `;
      invalidateTenantAccessCache(tenantId);
      if (res.length > 0) {
        await writePlatformAudit(sql, actor, "tenant.status_change", tenantId, {
          from: "provisioning",
          to: "active",
          reason: "provisioning completed",
        });
      }
      // An operator may have suspended it mid-provisioning — leave that alone.
      return { activated: res.length > 0, status: res.length > 0 ? "active" : tenant.status };
    }
  }
}

/** The console's view of a tenant's provisioning job (null → a pre-F11 tenant). */
export async function getProvisioningStatus(
  sql: SqlHandle,
  tenantId: string,
): Promise<ProvisioningStatus | null> {
  const job = await loadJob(sql, tenantId);
  if (!job) return null;
  const [t] = await sql<{ slug: string; display_name: string; status: string }[]>`
    SELECT slug, display_name, status FROM public.tenants WHERE id = ${tenantId}
  `;
  if (!t) return null;
  const isoOf = (v: Date | string | null) =>
    v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
  return {
    tenantId,
    slug: t.slug,
    displayName: t.display_name,
    tenantStatus: t.status,
    jobStatus: job.status,
    starterPack: { key: job.starter_pack_key, version: job.starter_pack_version },
    adminEmail: job.request.adminEmail,
    attempts: job.attempts,
    lastError: job.last_error,
    createdAt: isoOf(job.created_at) as string,
    completedAt: isoOf(job.completed_at),
    steps: PROVISIONING_STEPS.map((key) => {
      const s = job.steps[key];
      return {
        key,
        label: PROVISIONING_STEP_LABELS[key],
        status: s?.status === "done" ? "done" : s?.status === "failed" ? "failed" : "pending",
        completedAt: s?.status === "done" ? (s.at ?? null) : null,
        detail: s?.status === "failed" ? { error: s.error ?? null } : (s?.detail ?? {}),
      };
    }),
  };
}
