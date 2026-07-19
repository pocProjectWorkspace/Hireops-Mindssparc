import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * missing_info_requests — the lifecycle row for ONE candidate data field a
 * recruiter has chased (RECR-03). The Missing Info Tracker's `pending` state is
 * DERIVED (a required-or-tracked field is absent and no row exists here); this
 * table stores only the post-request states, mirroring the application-document
 * request→verify lifecycle:
 *
 *   requested → received → verified   (+ dismissed = the recruiter's "N/A")
 *
 * "Request" also enqueues a REAL candidate notification (notification_outbox,
 * dispatched by the worker); `notification_outbox_id` records that provenance.
 * There is deliberately NO score-impact / cap column — a missing field's hard
 * consequence is a deterministic stage-gate (see apps/api/src/lib/missing-info.ts),
 * never a fabricated score penalty.
 *
 * unique (tenant_id, application_id, field_key): ONE row per field per
 * application — re-requesting re-stamps `last_contact_at` on the same row.
 *
 * FKs: compound (tenant_id, application_id) → applications with CASCADE (the
 * chase is derived data that must not outlive its application);
 * (tenant_id, requested_by_membership_id) → memberships RESTRICT (provenance).
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companion migration 0087).
 */
export const missingInfoRequests = pgTable(
  "missing_info_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    applicationId: uuid("application_id").notNull(),

    fieldKey: text("field_key").notNull(),
    // requested | received | verified | dismissed. Defaults to 'requested' —
    // the row only exists once a recruiter has acted.
    status: text("status").notNull().default("requested"),
    note: text("note"),

    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    resolvedByMembershipId: uuid("resolved_by_membership_id"),
    // Back-reference to the notification_outbox row the "Request" enqueued.
    notificationOutboxId: uuid("notification_outbox_id"),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_missing_info_requests_tenant_id_id").on(table.tenantId, table.id),
    // ONE chase per (application, field) — re-request re-stamps this row.
    unique("uniq_missing_info_requests_field").on(
      table.tenantId,
      table.applicationId,
      table.fieldKey,
    ),

    index("idx_missing_info_requests_app").on(table.tenantId, table.applicationId),
    index("idx_missing_info_requests_status").on(table.tenantId, table.status),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_missing_info_requests_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.requestedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_missing_info_requests_requested_by",
    }).onDelete("restrict"),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type MissingInfoRequest = typeof missingInfoRequests.$inferSelect;
export type NewMissingInfoRequest = typeof missingInfoRequests.$inferInsert;
