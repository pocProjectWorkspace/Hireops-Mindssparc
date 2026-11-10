import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  jsonb,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { applications } from "./applications";
import { requisitions } from "./requisitions";
import { interviews } from "./interviews";

/**
 * PC-8 / PC-9 / PC-10 — in-app interview scheduling (migration 0127).
 *
 * Availability is held inside HireOps (no external calendar). See the header
 * of 0127_interview_scheduling.sql for the time model, why "needs reschedule"
 * is DERIVED from exceptions rather than stored, and how booking is
 * serialised.
 */

/** A fresh policy object per table (drizzle links a policy to its table). */
const tenantIsolation = () =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: ["authenticated"],
    using: sql`tenant_id = current_tenant_id()`,
    withCheck: sql`tenant_id = current_tenant_id()`,
  });

/** Weekly recurring window, wall-clock in `timezone`. 0 = Sunday … 6 = Saturday. */
export const panelistAvailabilityWindows = pgTable(
  "panelist_availability_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull(),
    dayOfWeek: smallint("day_of_week").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    timezone: text("timezone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_panelist_availability_windows_tenant_id_id").on(table.tenantId, table.id),
    index("idx_panelist_availability_windows_membership").on(table.tenantId, table.membershipId),
    check("panelist_availability_windows_dow_check", sql`${table.dayOfWeek} BETWEEN 0 AND 6`),
    check(
      "panelist_availability_windows_minutes_check",
      sql`${table.startMinute} >= 0 AND ${table.startMinute} < 1440 AND ${table.endMinute} > ${table.startMinute} AND ${table.endMinute} <= 1440`,
    ),
    check(
      "panelist_availability_windows_timezone_check",
      sql`char_length(${table.timezone}) BETWEEN 1 AND 64`,
    ),
    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_panelist_availability_windows_membership",
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();

/** Blocked / out-of-office / can't-attend range (concrete instants). */
export const panelistAvailabilityExceptions = pgTable(
  "panelist_availability_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("blocked"),
    reason: text("reason"),
    interviewId: uuid("interview_id").references(() => interviews.id, { onDelete: "set null" }),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_panelist_availability_exceptions_tenant_id_id").on(table.tenantId, table.id),
    index("idx_panelist_availability_exceptions_membership_range").on(
      table.tenantId,
      table.membershipId,
      table.endsAt,
    ),
    index("idx_panelist_availability_exceptions_interview")
      .on(table.tenantId, table.interviewId)
      .where(sql`interview_id IS NOT NULL`),
    check("panelist_availability_exceptions_range_check", sql`${table.endsAt} > ${table.startsAt}`),
    check(
      "panelist_availability_exceptions_kind_check",
      sql`${table.kind} IN ('blocked', 'out_of_office', 'cannot_attend')`,
    ),
    check(
      "panelist_availability_exceptions_reason_check",
      sql`${table.reason} IS NULL OR char_length(${table.reason}) <= 500`,
    ),
    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_panelist_availability_exceptions_membership",
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();

/** Slots offered to a candidate for one round (PC-9). */
export const interviewSlotOffers = pgTable(
  "interview_slot_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    requisitionId: uuid("requisition_id").notNull(),
    roundNumber: integer("round_number").notNull(),
    roundName: text("round_name").notNull(),
    replacesInterviewId: uuid("replaces_interview_id").references(() => interviews.id, {
      onDelete: "set null",
    }),
    bookedInterviewId: uuid("booked_interview_id").references(() => interviews.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    panelMembershipIds: uuid("panel_membership_ids").array().notNull(),
    leadMembershipId: uuid("lead_membership_id"),
    durationMinutes: integer("duration_minutes").notNull(),
    mode: text("mode").notNull(),
    meetingUrl: text("meeting_url"),
    slots: jsonb("slots").notNull().default([]),
    timezone: text("timezone").notNull(),
    tokenHash: text("token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    bookedSlotStart: timestamp("booked_slot_start", { withTimezone: true }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    bookedVia: text("booked_via"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_slot_offers_tenant_id_id").on(table.tenantId, table.id),
    uniqueIndex("uniq_interview_slot_offers_open_round")
      .on(table.tenantId, table.applicationId, table.roundNumber)
      .where(sql`status = 'open'`),
    index("idx_interview_slot_offers_application").on(table.tenantId, table.applicationId),
    index("idx_interview_slot_offers_token_hash")
      .on(table.tokenHash)
      .where(sql`token_hash IS NOT NULL`),
    check(
      "interview_slot_offers_status_check",
      sql`${table.status} IN ('open', 'booked', 'expired', 'cancelled', 'superseded')`,
    ),
    check(
      "interview_slot_offers_reason_check",
      sql`${table.reason} IN ('initial', 'candidate_reschedule', 'panelist_unavailable', 'recruiter_reschedule')`,
    ),
    check(
      "interview_slot_offers_booked_via_check",
      sql`${table.bookedVia} IS NULL OR ${table.bookedVia} IN ('candidate_link', 'candidate_portal')`,
    ),
    check("interview_slot_offers_mode_check", sql`${table.mode} IN ('video', 'onsite', 'phone')`),
    check("interview_slot_offers_duration_check", sql`${table.durationMinutes} BETWEEN 15 AND 480`),
    check("interview_slot_offers_slots_array_check", sql`jsonb_typeof(${table.slots}) = 'array'`),
    check("interview_slot_offers_panel_check", sql`cardinality(${table.panelMembershipIds}) >= 1`),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_interview_slot_offers_application",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_interview_slot_offers_requisition",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.createdByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_interview_slot_offers_created_by",
    }).onDelete("restrict"),
    tenantIsolation(),
  ],
).enableRLS();

export type PanelistAvailabilityWindow = typeof panelistAvailabilityWindows.$inferSelect;
export type PanelistAvailabilityException = typeof panelistAvailabilityExceptions.$inferSelect;
export type InterviewSlotOffer = typeof interviewSlotOffers.$inferSelect;
