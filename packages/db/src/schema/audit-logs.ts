import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  customType,
  index,
  unique,
  primaryKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { auditActionEnum } from "./audit-action";

// Postgres inet type — narrow custom mapping; the ip_address column survives
// IPv4 and IPv6 both. Stored as text on the JS side, validated at the DB.
const inet = customType<{ data: string; default: false }>({
  dataType() {
    return "inet";
  },
});

/**
 * Cross-cutting append-only audit of every tenant-scoped data change.
 *
 * One row per INSERT / UPDATE / DELETE on a mutable tenant-scoped table,
 * written by the `audit_record_change()` trigger. Sits alongside
 * `requisition_state_transitions` (workflow timeline) — this table is for
 * data diffs, that one is for state machine moves.
 *
 * Append-only enforcement matches requisition_state_transitions: split RLS
 * policies (tenant_isolation_select + tenant_isolation_insert) and no
 * UPDATE/DELETE policy under FORCE RLS. service_role retains write access
 * as a compliance escape hatch.
 *
 * PARTITIONING — IMPORTANT:
 * This table is RANGE PARTITIONED by `created_at` (monthly). Drizzle 0.45.2
 * doesn't model PARTITION BY in pgTable, so the migration that creates this
 * table is hand-edited: the generated CREATE TABLE is replaced with a
 * partitioned variant, and monthly partitions are created in the same file.
 * See drizzle/migrations/0012_*.sql (CREATE TABLE replacement) and
 * 0013_audit_force_rls_triggers.sql (FORCE RLS + trigger function + CREATE
 * TRIGGER on each domain table).
 *
 * Postgres requires the partition key to appear in every UNIQUE constraint
 * and the PRIMARY KEY of a partitioned table — that's why the PK is
 * (id, created_at) composite and the tenant uniqueness constraint is
 * (tenant_id, id, created_at) rather than (tenant_id, id).
 *
 * The trigger function runs SECURITY DEFINER as `postgres` (BYPASSRLS),
 * so its INSERT into audit_logs bypasses RLS — but it always sets
 * tenant_id from NEW.tenant_id (or OLD.tenant_id on delete), never from
 * a settable parameter. That's the safety bar.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").notNull().defaultRandom(),
    // Intentionally no FK to tenants(id). Cascade-trigger ordering inside a
    // single DELETE statement (DELETE tenants → cascade to business_units →
    // AFTER trigger inserts audit row → FK lookup of tenant fails because
    // the parent tenant is being deleted in the same statement) makes the
    // FK unworkable here. Compliance-wise this is also the right shape:
    // audit rows survive their subject's deletion. If a tenant is purged
    // for compliance reasons, a separate flow removes the matching audit
    // rows explicitly.
    tenantId: uuid("tenant_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: auditActionEnum("action").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorMembershipId: uuid("actor_membership_id"),
    requestId: text("request_id"),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
    source: text("source").notNull().default("app"),
    beforeData: jsonb("before_data"),
    afterData: jsonb("after_data"),
    changedColumns: text("changed_columns").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt], name: "audit_logs_pkey" }),
    unique("uniq_audit_logs_tenant_id_id_created_at").on(table.tenantId, table.id, table.createdAt),
    // Primary listing: events for a tenant, newest first.
    index("idx_audit_logs_tenant_chrono").on(table.tenantId, table.createdAt),
    // "History of this entity" query path.
    index("idx_audit_logs_entity").on(
      table.tenantId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    // "What did this user do" query path.
    index("idx_audit_logs_actor").on(table.tenantId, table.actorUserId, table.createdAt),
    pgPolicy("tenant_isolation_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
    // No UPDATE / DELETE policies — append-only under FORCE RLS.
  ],
).enableRLS();

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
