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
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { applicationStageEnum } from "./application-stage";

/**
 * Append-only audit of every application stage transition. Same shape as
 * requisition_state_transitions but for the candidate-application axis.
 *
 * Append-only enforcement is policy-based:
 *   - tenant_isolation_select  (SELECT)
 *   - tenant_isolation_insert  (INSERT)
 *   - NO UPDATE/DELETE policies → under FORCE RLS authenticated callers
 *     get zero rows for those operations.
 *
 * The audit_record_change() trigger is intentionally NOT attached to this
 * table. The whole point of this table is to BE the audit trail for
 * stage changes; auditing its inserts would duplicate the trail.
 *
 * actor_membership_id is nullable for system-originated transitions
 * (e.g. AI scoring auto-advancing the stage).
 */
export const applicationStateTransitions = pgTable(
  "application_state_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    fromStage: applicationStageEnum("from_stage"),
    toStage: applicationStageEnum("to_stage").notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    actorMembershipId: uuid("actor_membership_id"),
    reason: text("reason"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    unique("uniq_app_state_transitions_tenant_id_id").on(table.tenantId, table.id),
    // Primary access: stage history of a specific application, newest first.
    index("idx_app_state_transitions_app_chrono").on(
      table.tenantId,
      table.applicationId,
      table.transitionedAt,
    ),
    // "Everything that landed in stage X between window Y and Z".
    index("idx_app_state_transitions_stage_chrono").on(
      table.tenantId,
      table.toStage,
      table.transitionedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_app_state_transitions_application",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.actorMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_app_state_transitions_actor",
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

export type ApplicationStateTransition = typeof applicationStateTransitions.$inferSelect;
export type NewApplicationStateTransition = typeof applicationStateTransitions.$inferInsert;
