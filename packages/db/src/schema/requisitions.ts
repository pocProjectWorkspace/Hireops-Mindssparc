import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  uniqueIndex,
  index,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { positions } from "./positions";
import { jdVersions } from "./jd-versions";
import { headcountEnvelopes } from "./headcount-envelopes";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Active hiring opening against a position. Per requirements.md §5.1 and
 * architecture.md §5.1: requisitions ≠ positions. A requisition exists
 * because someone is hiring; the position is the org-chart slot.
 *
 * JD locked at req-creation: jd_version_id is NOT NULL and FK with RESTRICT,
 * so subsequent JD edits create new versions but never affect a live req.
 *
 * Status is a text column with a CHECK constraint (8 values). State
 * transitions are recorded in requisition_state_transitions; the column
 * here is the "current" state only.
 *
 * Posting is single-channel (posted_at / expires_at / is_public). Multi-
 * board posting is a future DB-* task with its own requisition_postings.
 *
 * primary_recruiter_id is NOT NULL — every req has exactly one owner. The
 * junction `requisition_recruiters` is sparse, used only when a req has
 * additional assignees beyond the primary.
 */
export const requisitions = pgTable(
  "requisitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    jdVersionId: uuid("jd_version_id")
      .notNull()
      .references(() => jdVersions.id, { onDelete: "restrict" }),
    headcountEnvelopeId: uuid("headcount_envelope_id").references(() => headcountEnvelopes.id, {
      onDelete: "set null",
    }),
    primaryRecruiterId: uuid("primary_recruiter_id")
      .notNull()
      .references(() => tenantUserMemberships.id, { onDelete: "restrict" }),
    hiringManagerId: uuid("hiring_manager_id")
      .notNull()
      .references(() => tenantUserMemberships.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    numberOfOpenings: integer("number_of_openings").notNull().default(1),
    targetStartDate: date("target_start_date"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isPublic: boolean("is_public").notNull().default(false),
    publicSlug: text("public_slug"),
    reasonForHold: text("reason_for_hold"),
    createdBy: uuid("created_by").references(() => tenantUserMemberships.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Public slug unique per tenant when set; collisions are routing bugs.
    uniqueIndex("idx_requisitions_public_slug")
      .on(table.tenantId, table.publicSlug)
      .where(sql`public_slug IS NOT NULL`),
    // Query path: reqs in a position; reqs in an envelope.
    index("idx_requisitions_position").on(table.tenantId, table.positionId),
    index("idx_requisitions_envelope").on(table.headcountEnvelopeId),
    index("idx_requisitions_recruiter").on(table.primaryRecruiterId),
    index("idx_requisitions_status").on(table.tenantId, table.status),
    check(
      "requisitions_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'on_hold', 'posted', 'filled', 'cancelled', 'closed')`,
    ),
    check("requisitions_openings_check", sql`${table.numberOfOpenings} >= 1`),
    check(
      "requisitions_posting_window_check",
      sql`(${table.postedAt} IS NULL OR ${table.expiresAt} IS NULL OR ${table.postedAt} <= ${table.expiresAt})`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type Requisition = typeof requisitions.$inferSelect;
export type NewRequisition = typeof requisitions.$inferInsert;
