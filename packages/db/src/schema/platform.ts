import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  check,
  unique,
  primaryKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * C1-F10 — the platform layer (migration 0134). Mirrors the hand-written SQL;
 * see that file for the full rationale.
 *
 * platform_operators — MindsSparc platform operators. NOT a tenant role and
 * NOT carried in the JWT: the API resolves operator status server-side from
 * the auth user id (platformProcedure). RLS enabled + FORCED with NO policies
 * → only the service-role pool reads it (same posture as
 * tenant_encryption_keys / scheduled_job_runs); allowlisted as a platform
 * table in lint-rls.ts. user_id FKs auth.users (cross-schema, in the SQL only).
 */
export const platformOperators = pgTable(
  "platform_operators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(), // 'owner' | 'operator' | 'support'
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [
    unique("platform_operators_user_id_unique").on(t.userId),
    check("platform_operators_role_check", sql`${t.role} IN ('owner', 'operator', 'support')`),
    check("platform_operators_email_check", sql`char_length(${t.email}) BETWEEN 3 AND 320`),
  ],
).enableRLS();

export type PlatformOperator = typeof platformOperators.$inferSelect;
export type NewPlatformOperator = typeof platformOperators.$inferInsert;

/**
 * platform_audit_log — one row per platform action. tenant_id is nullable
 * metadata (a platform-wide action has none) and ON DELETE SET NULL so the
 * trail outlives the tenant. `summary` holds metadata only (status from/to,
 * module keys, reason) — never tenant content. Append-only via the
 * platform_audit_log_append_only trigger. Platform table (no policies).
 */
export const platformAuditLog = pgTable(
  "platform_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").references(() => platformOperators.id, {
      onDelete: "set null",
    }),
    operatorEmail: text("operator_email").notNull(),
    action: text("action").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    summary: jsonb("summary").notNull().default({}),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_platform_audit_log_tenant_chrono").on(t.tenantId, t.createdAt.desc()),
    index("idx_platform_audit_log_chrono").on(t.createdAt.desc()),
    check("platform_audit_log_action_check", sql`${t.action} ~ '^[a-z][a-z0-9_.]{2,63}$'`),
  ],
).enableRLS();

export type PlatformAuditLogRow = typeof platformAuditLog.$inferSelect;

/**
 * tenant_modules — module entitlements over the platform catalogue
 * (PLATFORM_MODULE_KEYS in @hireops/api-types). A MISSING row means the module
 * is ENABLED (platform default), so existing tenants are unaffected on deploy.
 * Tenant-scoped: a tenant may SELECT its own rows; there is NO write policy —
 * only the platform (service role, via platformProcedure) writes.
 *
 * enabled_at          — when the module was last switched on (null if never
 *                       switched on through the console).
 * enabled_by_operator — the operator who last changed the row.
 */
export const tenantModules = pgTable(
  "tenant_modules",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    moduleKey: text("module_key").notNull(),
    enabled: boolean("enabled").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    enabledByOperator: uuid("enabled_by_operator").references(() => platformOperators.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "tenant_modules_pkey", columns: [t.tenantId, t.moduleKey] }),
    check("tenant_modules_module_key_check", sql`${t.moduleKey} ~ '^[a-z][a-z0-9_]{1,62}$'`),
    pgPolicy("tenant_isolation_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TenantModuleRow = typeof tenantModules.$inferSelect;
