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
import { partnerUsers } from "./partner-users";
import { candidates } from "./candidates";
import { applications } from "./applications";

/**
 * Logged partner-to-candidate messages. Wave 1 ships the schema; the
 * messaging UI itself ships in Wave 2.
 *
 * Decision: single tenant_isolation policy, NOT append-only split.
 * The ticket flagged this as a "stop and ask if" — delivery_status is
 * legitimately mutable state (pending → sent → delivered/failed) and the
 * append-only contract was aspirational. Single policy lets the
 * messaging system update delivery_status without fighting RLS; row
 * content (subject/body/sent_at) is still effectively immutable by
 * convention (no UI path that mutates).
 *
 * NO audit trigger attached — the table is conceptually a log even if
 * it's not strictly append-only at the RLS layer. Same exclusion
 * rationale as candidate_dedup_attempts.
 */
export const partnerCandidateMessages = pgTable(
  "partner_candidate_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerUserId: uuid("partner_user_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    applicationId: uuid("application_id"),
    subject: text("subject"),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    // Free text not enum — Wave 1 doesn't know all the statuses messaging
    // infra will surface. Enum once usage stabilises.
    deliveryStatus: text("delivery_status"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    unique("uniq_partner_candidate_messages_tenant_id_id").on(table.tenantId, table.id),
    index("idx_pcm_candidate_chrono").on(table.tenantId, table.candidateId, table.sentAt),
    index("idx_pcm_partner_user_chrono").on(table.tenantId, table.partnerUserId, table.sentAt),
    foreignKey({
      columns: [table.tenantId, table.partnerUserId],
      foreignColumns: [partnerUsers.tenantId, partnerUsers.id],
      name: "fk_pcm_partner_user",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.candidateId],
      foreignColumns: [candidates.tenantId, candidates.id],
      name: "fk_pcm_candidate",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_pcm_application",
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

export type PartnerCandidateMessage = typeof partnerCandidateMessages.$inferSelect;
export type NewPartnerCandidateMessage = typeof partnerCandidateMessages.$inferInsert;
