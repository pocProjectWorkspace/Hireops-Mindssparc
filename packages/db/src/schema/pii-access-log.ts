import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, foreignKey, pgPolicy } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * pii_access_log — every high-value PII read: who / when / why.
 *
 * ADR-002 §7 makes this mandatory under DPDPA: credential reads (and, more
 * broadly, PII reads) MUST log with tenant_id, integration_type / entity,
 * actor, reason, and accessed_at. This table is the append-only accountability
 * record that answers "who looked at this candidate's PII, and why."
 *
 * Deliberately narrow for Wave 1 / demo: recording is wired at the two
 * highest-value read points only — getCandidateById (candidate PII) and
 * getIntegrationCredential (decrypted integration secrets). Full coverage of
 * every PII read (listCandidates, triage, offer reads, etc.) is post-demo
 * scope; those are the known coverage gap, not a defect.
 *
 * Modelled on api_audit_logs end-to-end:
 *   - No partitioning. Wave 1 volume (300 candidates/month → a few thousand
 *     PII reads/month) doesn't justify the monthly-partition machinery that
 *     audit_logs carries. Revisit if volume grows.
 *   - No audit_record_change trigger — this IS an audit log; attaching the
 *     trigger would create a 1:1 noise stream (same exclusion as
 *     api_audit_logs / ai_usage_logs / the *_state_transitions tables).
 *   - Append-only under FORCE RLS: split tenant_isolation_select +
 *     tenant_isolation_insert policies, no UPDATE / DELETE for authenticated.
 *
 * actor_label is the ADR's actor concept as free text (e.g. 'user',
 * 'service_role', 'ai-client', 'workday-sync-worker'). When the actor is a
 * human the label is still 'user' and actor_user_id / actor_membership_id are
 * filled; service-role reads carry a descriptive worker label and null ids.
 *
 * entity_type + entity_id identify what was read (e.g. 'candidate' + candidate
 * id, 'integration_credential' + credential row id). fields_accessed lists the
 * column / field names when known. reason is the snake_case call site
 * (e.g. 'get_candidate_by_id', 'ai_client.credential_read').
 */
export const piiAccessLog = pgTable(
  "pii_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    actorMembershipId: uuid("actor_membership_id"),
    actorLabel: text("actor_label").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    fieldsAccessed: text("fields_accessed").array(),
    reason: text("reason").notNull(),
    requestId: text("request_id"),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_pii_access_log_tenant_chrono").on(table.tenantId, table.accessedAt.desc()),
    index("idx_pii_access_log_tenant_entity").on(
      table.tenantId,
      table.entityType,
      table.entityId,
    ),
    foreignKey({
      columns: [table.tenantId, table.actorMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_pii_access_log_actor",
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

export type PiiAccessLog = typeof piiAccessLog.$inferSelect;
export type NewPiiAccessLog = typeof piiAccessLog.$inferInsert;
