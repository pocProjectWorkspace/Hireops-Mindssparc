import { z } from "zod";

/**
 * C1-F10 — the platform layer (Plan A §14 / F10): platform operators, the
 * tenant registry + lifecycle, and module entitlements.
 *
 * Platform operators are NOT a tenant role. They live in `platform_operators`
 * (outside tenant RLS) and are resolved server-side from the auth user id. They
 * see tenant METADATA only — slug, name, status, tier, modules, counts, queue
 * health — never candidate or requisition content.
 */

// Postgres accepts any 8-4-4-4-12 hex value as a uuid (seeded tenants use
// non-RFC ids), so the lenient guid form, as in ./learning.ts.
const pgUuid = z.guid();

// ── Tenant lifecycle ────────────────────────────────────────────────────────

export const TENANT_STATUSES = [
  "provisioning",
  "active",
  "suspended",
  "churned",
  "deleting",
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
export const tenantStatusSchema = z.enum(TENANT_STATUSES);

/** Only an `active` tenant may sign in, call tenant procedures or be worked by workers. */
export function isTenantActive(status: string | null | undefined): boolean {
  return status === "active";
}

/** tRPC FORBIDDEN message when the caller's tenant is not `active`. */
export const TENANT_SUSPENDED_ERROR = "tenant_suspended";
/** tRPC FORBIDDEN message prefix when a module is not enabled for the tenant. */
export const MODULE_DISABLED_ERROR_PREFIX = "module_disabled:";
/** tRPC FORBIDDEN message when the caller is not an active platform operator. */
export const NOT_PLATFORM_OPERATOR_ERROR = "not_a_platform_operator";

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  provisioning: "Provisioning",
  active: "Active",
  suspended: "Suspended",
  churned: "Churned",
  deleting: "Scheduled for deletion",
};

/**
 * The sentence a person sees when their organisation's access is not active.
 * One wording for every door (internal, candidate, partner).
 */
/** For the `?reason=tenant-inactive` sign-out landing, where the exact state is not carried. */
export const TENANT_INACTIVE_GENERIC_MESSAGE =
  "Your organisation's HireOps access is not active. Please contact your administrator.";

export function tenantInactiveMessage(status: string | null | undefined): string {
  if (status === "provisioning") {
    return "Your organisation's HireOps workspace is still being set up. Please try again later.";
  }
  if (status === "suspended") {
    return "Your organisation's HireOps access is currently suspended. Please contact your administrator.";
  }
  return "Your organisation's HireOps access has ended. Please contact your administrator.";
}

// ── Module entitlements ─────────────────────────────────────────────────────

/**
 * The platform module catalogue. A tenant has a module unless a
 * `tenant_modules` row says `enabled = false` — a missing row means enabled,
 * so existing tenants (and modules added to this list later) keep working on
 * deploy. Keys are data in the DB (text + format CHECK), so growing this list
 * needs no DDL.
 */
export const PLATFORM_MODULE_KEYS = [
  "ai_interview",
  "notetaker",
  "market_intel",
  "partner_portal",
  "onboarding",
  "learning",
  "bulk_cv_upload",
  "scheduling",
  "pre_joining_engagement",
  "welcome_guide",
  "diversity_slate",
  "ask_data",
  "report_insights",
  "workday_handoff",
] as const;
export type PlatformModuleKey = (typeof PLATFORM_MODULE_KEYS)[number];
export const platformModuleKeySchema = z.enum(PLATFORM_MODULE_KEYS);

export const PLATFORM_MODULE_LABELS: Record<PlatformModuleKey, string> = {
  ai_interview: "AI first-round interview",
  notetaker: "Interview notetaker",
  market_intel: "Market intelligence",
  partner_portal: "Partner portal",
  onboarding: "Onboarding",
  learning: "Learning (L&D)",
  bulk_cv_upload: "Bulk CV upload",
  scheduling: "Interview self-scheduling",
  pre_joining_engagement: "Pre-joining engagement",
  welcome_guide: "Welcome guide",
  diversity_slate: "Diverse slate",
  ask_data: "Ask your data",
  report_insights: "Report insights (AI)",
  workday_handoff: "Workday handoff",
};

export function isPlatformModuleKey(key: string): key is PlatformModuleKey {
  return (PLATFORM_MODULE_KEYS as readonly string[]).includes(key);
}

/**
 * Resolve the full catalogue for a tenant from its explicit `tenant_modules`
 * rows. Unknown keys in the DB are ignored; a key with no row is enabled.
 */
export function resolveTenantModules(
  rows: readonly { moduleKey: string; enabled: boolean }[],
): Record<PlatformModuleKey, boolean> {
  const out = Object.fromEntries(PLATFORM_MODULE_KEYS.map((k) => [k, true])) as Record<
    PlatformModuleKey,
    boolean
  >;
  for (const r of rows) {
    if (isPlatformModuleKey(r.moduleKey)) out[r.moduleKey] = r.enabled;
  }
  return out;
}

// ── Platform operators ──────────────────────────────────────────────────────

export const PLATFORM_OPERATOR_ROLES = ["owner", "operator", "support"] as const;
export type PlatformOperatorRole = (typeof PLATFORM_OPERATOR_ROLES)[number];
export const platformOperatorRoleSchema = z.enum(PLATFORM_OPERATOR_ROLES);

/** Roles allowed to change tenant state. `support` is read-only. */
export const PLATFORM_WRITE_ROLES: readonly PlatformOperatorRole[] = ["owner", "operator"];

export const platformWhoamiOutputSchema = z.object({
  operatorId: pgUuid,
  email: z.string(),
  role: platformOperatorRoleSchema,
  canWrite: z.boolean(),
});
export type PlatformWhoamiOutput = z.infer<typeof platformWhoamiOutputSchema>;

// ── Tenant registry (metadata only) ─────────────────────────────────────────

export const platformTenantSummarySchema = z.object({
  id: pgUuid,
  slug: z.string(),
  displayName: z.string(),
  status: z.string(),
  tier: z.string(),
  primaryRegion: z.string(),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  activeMembers: z.number().int(),
  activeRequisitions: z.number().int(),
  disabledModules: z.array(z.string()),
});
export type PlatformTenantSummary = z.infer<typeof platformTenantSummarySchema>;

export const platformListTenantsOutputSchema = z.object({
  items: z.array(platformTenantSummarySchema),
});
export type PlatformListTenantsOutput = z.infer<typeof platformListTenantsOutputSchema>;

export const platformTenantModuleSchema = z.object({
  key: platformModuleKeySchema,
  label: z.string(),
  enabled: z.boolean(),
  /** false → no row: the platform default (enabled) applies. */
  explicit: z.boolean(),
  changedAt: z.string().nullable(),
});
export type PlatformTenantModule = z.infer<typeof platformTenantModuleSchema>;

export const platformAuditEntrySchema = z.object({
  id: pgUuid,
  operatorEmail: z.string(),
  action: z.string(),
  summary: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type PlatformAuditEntry = z.infer<typeof platformAuditEntrySchema>;

export const platformGetTenantInputSchema = z.object({ tenantId: pgUuid });

export const platformGetTenantOutputSchema = z.object({
  tenant: platformTenantSummarySchema.extend({
    onboardingStatus: z.string(),
    scheduledDeletionAt: z.string().nullable(),
    partnerUsers: z.number().int(),
    candidateAccounts: z.number().int(),
  }),
  modules: z.array(platformTenantModuleSchema),
  recentAudit: z.array(platformAuditEntrySchema),
});
export type PlatformGetTenantOutput = z.infer<typeof platformGetTenantOutputSchema>;

export const platformSetTenantStatusInputSchema = z.object({
  tenantId: pgUuid,
  status: tenantStatusSchema,
  reason: z.string().trim().min(3).max(500),
});
export type PlatformSetTenantStatusInput = z.infer<typeof platformSetTenantStatusInputSchema>;

export const platformSetTenantStatusOutputSchema = z.object({
  tenantId: pgUuid,
  previousStatus: z.string(),
  status: tenantStatusSchema,
});

export const platformSetTenantModulesInputSchema = z.object({
  tenantId: pgUuid,
  modules: z
    .array(z.object({ key: platformModuleKeySchema, enabled: z.boolean() }))
    .min(1)
    .max(PLATFORM_MODULE_KEYS.length),
  reason: z.string().trim().max(500).optional(),
});
export type PlatformSetTenantModulesInput = z.infer<typeof platformSetTenantModulesInputSchema>;

export const platformSetTenantModulesOutputSchema = z.object({
  tenantId: pgUuid,
  changed: z.array(z.object({ key: platformModuleKeySchema, enabled: z.boolean() })),
});

// ── Platform health (counts only) ───────────────────────────────────────────

export const PLATFORM_QUEUE_KEYS = [
  "notification_outbox",
  "ai_score_outbox",
  "transcript_outbox",
  "agent_run_outbox",
  "workday_sync_outbox",
  "bulk_cv_items",
  "pre_joining_touchpoints",
  "ai_interview_evidence",
] as const;
export type PlatformQueueKey = (typeof PLATFORM_QUEUE_KEYS)[number];

export const platformQueueHealthSchema = z.object({
  queue: z.enum(PLATFORM_QUEUE_KEYS),
  backlog: z.number().int(),
  failed7d: z.number().int(),
  oldestBacklogAt: z.string().nullable(),
});

export const platformTenantHealthSchema = z.object({
  tenantId: pgUuid,
  slug: z.string(),
  displayName: z.string(),
  status: z.string(),
  queues: z.array(platformQueueHealthSchema),
});

export const platformJobHeartbeatSchema = z.object({
  jobName: z.string(),
  lastRunAt: z.string(),
  lastRunStatus: z.string(),
  lastRunDurationMs: z.number().int().nullable(),
});

export const platformGetHealthOutputSchema = z.object({
  generatedAt: z.string(),
  tenants: z.array(platformTenantHealthSchema),
  /** Worker scheduled-job heartbeat — platform-wide (jobs are cross-tenant). */
  jobs: z.array(platformJobHeartbeatSchema),
});
export type PlatformGetHealthOutput = z.infer<typeof platformGetHealthOutputSchema>;

// ── Sign-in access status (the login doors) ─────────────────────────────────

export const ACCOUNT_AUDIENCES = ["internal", "partner", "candidate"] as const;
export type AccountAudience = (typeof ACCOUNT_AUDIENCES)[number];

export const accountAccessStatusInputSchema = z.object({
  audience: z.enum(ACCOUNT_AUDIENCES),
});

export const accountAccessStatusOutputSchema = z.object({
  /** The signed-in identity is an active platform operator. */
  platformOperator: z.boolean(),
  /**
   * `ok` — at least one identity for this audience sits in an active tenant;
   * `tenant_inactive` — identities exist but every one is in a non-active
   * tenant (`tenantStatus` says which state); `no_account` — no identity.
   */
  access: z.enum(["ok", "tenant_inactive", "no_account"]),
  tenantStatus: z.string().nullable(),
  message: z.string().nullable(),
});
export type AccountAccessStatusOutput = z.infer<typeof accountAccessStatusOutputSchema>;
