import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * API-layer audit of opt-in tRPC procedure calls.
 *
 * Sits alongside audit_logs (row-change capture) and the various
 * *_state_transitions tables (workflow timelines). This table captures
 * INTENT: a recruiter called getCandidateById; a candidate submitted an
 * application. The data-change side of those calls (rows inserted /
 * updated) is already recorded by the audit_record_change() trigger;
 * api_audit_logs answers "what API action drove the change," which is
 * the question regulators ask.
 *
 * Why a separate table from audit_logs:
 *   - audit_logs.action is pgEnum('insert'|'update'|'delete') — DML
 *     verbs only. API actions ('submit_application', 'get_candidate_by_id')
 *     don't fit. Extending the enum would conflate two audit purposes
 *     and bias every future query against the enum.
 *   - audit_logs is partitioned monthly with bespoke trigger machinery.
 *     api_audit_logs volume at Wave 1 (300 candidates/month → maybe
 *     ~10k API calls/month) doesn't justify partitioning yet.
 *
 * Append-only. Split policies (tenant_isolation_select +
 * tenant_isolation_insert), no UPDATE/DELETE for authenticated under
 * FORCE RLS. No audit trigger attached — this IS the audit log.
 *
 * action is free text in Wave 1 (e.g. 'submit_application',
 * 'get_candidate_by_id'). Convention: snake_case of the procedure name.
 * Consider an enum or CHECK if usage stabilises and we want grouping.
 */
export const apiAuditLogs = pgTable(
  "api_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorMembershipId: uuid("actor_membership_id"),
    requestId: text("request_id"),
    source: text("source").notNull().default("app"),
    inputJson: jsonb("input_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_api_audit_logs_tenant_chrono").on(table.tenantId, table.createdAt),
    index("idx_api_audit_logs_tenant_action").on(table.tenantId, table.action, table.createdAt),
    index("idx_api_audit_logs_actor").on(table.tenantId, table.actorUserId, table.createdAt),
    unique("uniq_api_audit_logs_tenant_id_id").on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.actorMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_api_audit_logs_actor",
    }).onDelete("set null"),
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

export type ApiAuditLog = typeof apiAuditLogs.$inferSelect;
export type NewApiAuditLog = typeof apiAuditLogs.$inferInsert;
