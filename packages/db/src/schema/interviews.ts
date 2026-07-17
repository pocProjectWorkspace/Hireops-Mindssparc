import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * interviews — one per candidate per round (Wave B, INT-01).
 *
 * Instantiated (INT-02) from an interview_plans template when a candidate
 * reaches the interview stage. Holds the concrete booking: when, how, the
 * meeting URL, and confirmation state. The panel is relational
 * (interview_panelists); feedback is relational (interview_feedback).
 *
 * Denormalised `requisition_id` (compound FK alongside application_id): the
 * panel-side surface (INT-03 "my interviews") queries interviews by
 * requisition/role without joining through applications on every read. Kept
 * consistent by the fact that an application's requisition never changes.
 *
 * `status` uses the text + CHECK convention (NOT pgEnum) — HANDOVER reality
 * #114. Lifecycle: scheduled → completed ↘ cancelled ↘ no_show.
 *
 * `external_booking_ref` is the calendar-provider / Cal.diy seam: when a
 * round is booked through an external scheduling provider, its opaque
 * reference lands here so INT-02+ can reconcile/cancel against the provider.
 * REQUIRED column — nullable because in-portal manual scheduling leaves it
 * empty.
 *
 * `created_by_membership_id` compound FK → memberships uses onDelete
 * RESTRICT: compound FKs cannot SET NULL (the tenant_id leg is NOT NULL), so
 * per HANDOVER reality #63 we RESTRICT rather than orphan the creator — same
 * treatment as offers.drafted_by.
 */
export const interviews = pgTable(
  "interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    // Denormalised for panel-side queries — see file header.
    requisitionId: uuid("requisition_id").notNull(),

    roundNumber: integer("round_number").notNull(),
    roundName: text("round_name").notNull(),
    status: text("status").notNull().default("scheduled"),

    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    mode: text("mode").notNull(),

    meetingUrl: text("meeting_url"),
    // Calendar-provider / Cal.diy seam — opaque external booking reference.
    externalBookingRef: text("external_booking_ref"),
    candidateConfirmedAt: timestamp("candidate_confirmed_at", { withTimezone: true }),

    createdByMembershipId: uuid("created_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interviews_tenant_id_id").on(table.tenantId, table.id),

    // At most one NON-cancelled interview per (tenant, application, round).
    // Cancelled rounds are unconstrained so a round can be re-booked freely.
    uniqueIndex("uniq_interviews_application_round_active")
      .on(table.tenantId, table.applicationId, table.roundNumber)
      .where(sql`status <> 'cancelled'`),

    index("idx_interviews_application").on(table.tenantId, table.applicationId),
    index("idx_interviews_requisition").on(table.tenantId, table.requisitionId),
    index("idx_interviews_status").on(table.tenantId, table.status),
    // Upcoming-interviews sweep / calendar ordering.
    index("idx_interviews_scheduled_start").on(table.tenantId, table.scheduledStart),

    check(
      "interviews_status_check",
      sql`${table.status} IN ('scheduled', 'completed', 'cancelled', 'no_show')`,
    ),
    check("interviews_mode_check", sql`${table.mode} IN ('video', 'onsite', 'phone')`),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_interviews_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_interviews_requisition",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.createdByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_interviews_created_by",
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

export type Interview = typeof interviews.$inferSelect;
export type NewInterview = typeof interviews.$inferInsert;
