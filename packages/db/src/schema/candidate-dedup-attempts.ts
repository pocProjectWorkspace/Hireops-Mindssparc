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
import { persons } from "./persons";
import { partnerUsers } from "./partner-users";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { dedupDecisionEnum } from "./dedup-decision";

/**
 * Append-only audit of every dedup decision made during a submission.
 *
 * Two-actor: a submission can be partner-initiated (attempted_by_partner_user_id)
 * or internal-initiated (attempted_by_membership_id). Both nullable; the
 * non-null one tells you which side acted.
 *
 * No retention sweep yet — keep indefinitely. The
 * (tenant_id, created_at) index is the path the sweep will use when
 * DPDPA-driven retention lands.
 *
 * Append-only: split RLS policies (tenant_isolation_select + _insert).
 * NO audit trigger — this IS the audit log. Same pattern as ai_usage_logs
 * and *_state_transitions tables.
 */
export const candidateDedupAttempts = pgTable(
  "candidate_dedup_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    attemptedByPartnerUserId: uuid("attempted_by_partner_user_id"),
    attemptedByMembershipId: uuid("attempted_by_membership_id"),
    submittedEmail: text("submitted_email"),
    submittedPhone: text("submitted_phone"),
    matchedPersonId: uuid("matched_person_id"),
    decision: dedupDecisionEnum("decision").notNull(),
    decisionReason: text("decision_reason"),
    submissionMetadata: jsonb("submission_metadata"),
  },
  (table) => [
    unique("uniq_candidate_dedup_attempts_tenant_id_id").on(table.tenantId, table.id),
    index("idx_dedup_tenant_chrono").on(table.tenantId, table.attemptedAt),
    // "Who tried to dedup against this person?" — only matters when matched.
    index("idx_dedup_tenant_matched_person")
      .on(table.tenantId, table.matchedPersonId, table.attemptedAt)
      .where(sql`matched_person_id IS NOT NULL`),
    index("idx_dedup_tenant_decision").on(table.tenantId, table.decision, table.attemptedAt),
    foreignKey({
      columns: [table.tenantId, table.attemptedByPartnerUserId],
      foreignColumns: [partnerUsers.tenantId, partnerUsers.id],
      name: "fk_dedup_partner_user",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.tenantId, table.attemptedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_dedup_membership",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.tenantId, table.matchedPersonId],
      foreignColumns: [persons.tenantId, persons.id],
      name: "fk_dedup_matched_person",
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

export type CandidateDedupAttempt = typeof candidateDedupAttempts.$inferSelect;
export type NewCandidateDedupAttempt = typeof candidateDedupAttempts.$inferInsert;
