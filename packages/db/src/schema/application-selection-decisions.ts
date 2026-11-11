import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { applicationStageEnum } from "./application-stage";

/**
 * PC-12 (migration 0129) — the explicit final selection decision on an
 * application: selected / not_selected / on_hold, by the requisition's hiring
 * manager, a recruiter or an admin.
 *
 * APPEND-ONLY history, the application_state_transitions posture: SELECT +
 * INSERT tenant_isolation_* policies and NO UPDATE / DELETE policy, so under
 * FORCE RLS an authenticated caller can never rewrite or remove a decision.
 * The latest row (by decided_at) is the current decision; every earlier row
 * stays as history.
 *
 * Unlike application_state_transitions this table IS audited
 * (audit_record_change): an on_hold decision moves no stage, so there is no
 * transition row to stand in for it.
 *
 * `reason_label` snapshots the reason's label as it read at decision time — the
 * reason list is a tenants.settings lookup the tenant can edit later.
 * `transition_id` points at the stage transition the decision caused (selected
 * / not_selected), or is null; it is a plain uuid, not an FK, so a cleanup of
 * the transition trail can never be blocked by (or cascade into) the decision.
 */
export const applicationSelectionDecisions = pgTable(
  "application_selection_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    decision: text("decision").notNull(),
    reasonKey: text("reason_key"),
    reasonLabel: text("reason_label"),
    notes: text("notes"),
    decidedByMembershipId: uuid("decided_by_membership_id"),
    fromStage: applicationStageEnum("from_stage").notNull(),
    toStage: applicationStageEnum("to_stage"),
    transitionId: uuid("transition_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_app_selection_decisions_tenant_id_id").on(table.tenantId, table.id),
    // Primary access: an application's decision history, newest first; and the
    // latest-per-application chip read.
    index("idx_app_selection_decisions_app_chrono").on(
      table.tenantId,
      table.applicationId,
      table.decidedAt,
    ),
    check(
      "application_selection_decisions_decision_check",
      sql`${table.decision} IN ('selected', 'not_selected', 'on_hold')`,
    ),
    check(
      "application_selection_decisions_notes_len_check",
      sql`${table.notes} IS NULL OR char_length(${table.notes}) <= 2000`,
    ),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_app_selection_decisions_application",
    }).onDelete("cascade"),
    // Single-column FK so ON DELETE SET NULL can never null tenant_id.
    foreignKey({
      columns: [table.decidedByMembershipId],
      foreignColumns: [tenantUserMemberships.id],
      name: "fk_app_selection_decisions_decided_by",
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

export type ApplicationSelectionDecision = typeof applicationSelectionDecisions.$inferSelect;
export type NewApplicationSelectionDecision = typeof applicationSelectionDecisions.$inferInsert;
