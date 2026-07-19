import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * hr_case_notes — free-text HR-ops notes on an application's case (HROPS-03).
 *
 * A note is a durable domain row AND an audit-worthy event: the
 * audit_record_change() trigger (attached in the audit-triggers migration)
 * fires on INSERT and writes a REAL audit_logs row (entity_type
 * 'hr_case_notes', after_data carrying the note text + application_id), which
 * the /case-audit timeline surfaces alongside the trigger-written stage /
 * offer / document events for the same application. Modelling the note as its
 * own table (rather than a hand-crafted audit_logs insert) keeps the note
 * durable beyond the monthly audit-partition retention and reuses the existing
 * audit machinery verbatim.
 *
 * Notes are append-only in practice (the surface only adds, never edits), but
 * the tenant_isolation policy is permissive-all for consistency with the other
 * tenant-scoped tables; FORCE RLS is added in the companion migration.
 */
export const hrCaseNotes = pgTable(
  "hr_case_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    note: text("note").notNull(),
    authorMembershipId: uuid("author_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_case_notes_tenant_id_id").on(table.tenantId, table.id),
    index("idx_hr_case_notes_app_chrono").on(table.tenantId, table.applicationId, table.createdAt),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_hr_case_notes_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.authorMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_hr_case_notes_author",
    }).onDelete("set null"),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type HrCaseNote = typeof hrCaseNotes.$inferSelect;
export type NewHrCaseNote = typeof hrCaseNotes.$inferInsert;
