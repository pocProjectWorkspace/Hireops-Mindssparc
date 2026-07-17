import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  boolean,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviews } from "./interviews";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * interview_panelists — the relational panel for an interview (Wave B,
 * INT-01). One row per (interview, membership); this is the real panel that
 * the panel-side surface (INT-03 "my interviews") queries by membership.
 *
 * `is_lead` marks the round owner (writes the summary / drives the loop).
 *
 * Both compound FKs; the membership FK uses onDelete RESTRICT (compound FKs
 * cannot SET NULL — HANDOVER reality #63). The interview FK cascades: drop
 * the interview, drop its panel.
 */
export const interviewPanelists = pgTable(
  "interview_panelists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    interviewId: uuid("interview_id").notNull(),
    membershipId: uuid("membership_id").notNull(),

    isLead: boolean("is_lead").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_panelists_tenant_id_id").on(table.tenantId, table.id),

    // A membership sits on a given interview at most once.
    unique("uniq_interview_panelists_interview_membership").on(
      table.tenantId,
      table.interviewId,
      table.membershipId,
    ),

    index("idx_interview_panelists_interview").on(table.tenantId, table.interviewId),
    // "My interviews" panel-side lookup by the logged-in panelist.
    index("idx_interview_panelists_membership").on(table.tenantId, table.membershipId),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_interview_panelists_interview",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_interview_panelists_membership",
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

export type InterviewPanelist = typeof interviewPanelists.$inferSelect;
export type NewInterviewPanelist = typeof interviewPanelists.$inferInsert;
