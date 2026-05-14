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
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Append-only audit of requisition state machine transitions.
 *
 * Append-only enforcement is policy-based at RLS:
 *   - `tenant_isolation_select` allows SELECT for authenticated rows in the
 *     caller's tenant
 *   - `tenant_isolation_insert` allows INSERT with the tenant_id check
 *   - NO UPDATE or DELETE policies for authenticated → under FORCE RLS
 *     these operations match zero rows, so attempts return rowCount=0
 *
 * service_role (BYPASSRLS) can still rewrite history, but that's an
 * intentional admin escape hatch.
 *
 * FK to requisitions is ON DELETE RESTRICT — audit must survive across
 * the live row's deletion. If a req is truly purged for compliance reasons,
 * a separate cascade-aware delete path will need to be written.
 *
 * from_status is nullable for the very first transition (req creation —
 * nothing was the previous state).
 */
export const requisitionStateTransitions = pgTable(
  "requisition_state_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    transitionedBy: uuid("transitioned_by"),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    index("idx_req_transitions_chrono").on(table.requisitionId, table.transitionedAt),
    unique("uniq_requisition_state_transitions_tenant_id_id").on(table.tenantId, table.id),
    check(
      "req_transition_to_status_check",
      sql`${table.toStatus} IN ('draft', 'pending_approval', 'approved', 'on_hold', 'posted', 'filled', 'cancelled', 'closed')`,
    ),
    check(
      "req_transition_from_status_check",
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('draft', 'pending_approval', 'approved', 'on_hold', 'posted', 'filled', 'cancelled', 'closed')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_requisition_transitions_requisition",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.transitionedBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_requisition_transitions_transitioned_by",
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
    // No UPDATE / DELETE policies — under FORCE RLS authenticated callers
    // get zero rows for those operations. This is the append-only contract.
  ],
).enableRLS();

export type RequisitionStateTransition = typeof requisitionStateTransitions.$inferSelect;
export type NewRequisitionStateTransition = typeof requisitionStateTransitions.$inferInsert;
