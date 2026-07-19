import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  smallint,
  timestamp,
  index,
  uniqueIndex,
  unique,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { candidates } from "./candidates";

/**
 * Outbox pattern for async notifications.
 *
 * Writers (mutations, scheduled jobs) insert rows in the same
 * transaction as the triggering state change. The worker (apps/workers)
 * polls every 5s, claims a batch via UPDATE ... WHERE id IN (... FOR
 * UPDATE SKIP LOCKED), dispatches each via the EmailProvider, marks
 * sent/failed. SKIP LOCKED makes the claim safe under multiple worker
 * instances even though Wave 1 runs only one.
 *
 * dedup_key prevents double-sends for events that may fire twice
 * (mutation retries, idempotent state-change handlers). UNIQUE
 * (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL — partial so
 * rows without a dedup_key (one-off sends) don't collide.
 *
 * status: pending → processing → sent | failed | cancelled. Failed
 * rows are retried by the worker with backoff up to a small cap;
 * after the cap they stay 'failed' and surface on a dashboard a
 * future ticket will build.
 *
 * recipient_email is denormalised — it survives candidate redaction
 * (the original send is part of the audit record).
 *
 * FK strategy: recipient_membership_id / recipient_candidate_id are
 * SINGLE-COLUMN FKs on .id (not compound (tenant_id, id)). The compound
 * form with ON DELETE SET NULL is rejected by Postgres because SET NULL
 * on a composite FK nulls EVERY referenced column, and tenant_id is
 * NOT NULL. tenant integrity is already guaranteed by the row's own
 * (tenant_id → tenants.id) FK + the tenant_isolation policy. Cross-
 * tenant leakage on the recipient pointer is not feasible: the worker
 * reads the row's denormalised tenant_id and never joins through the
 * recipient pointer.
 *
 * RLS: standard single tenant_isolation. Audit trigger attached
 * (every insert is a state change worth recording).
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    recipientType: text("recipient_type").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    recipientMembershipId: uuid("recipient_membership_id").references(
      () => tenantUserMemberships.id,
      { onDelete: "set null" },
    ),
    recipientCandidateId: uuid("recipient_candidate_id").references(() => candidates.id, {
      onDelete: "set null",
    }),
    templateKey: text("template_key").notNull(),
    templateData: jsonb("template_data").notNull().default({}),
    dedupKey: text("dedup_key"),
    subject: text("subject"),
    status: text("status").notNull().default("pending"),
    priority: smallint("priority").notNull().default(5),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    attemptCount: smallint("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    // CAND-02 — persisted read-state for the candidate Notifications feed
    // (/candidate/notifications). NULL = unread; set only by
    // candidateMarkNotificationsRead, person-scoped via recipient_candidate_id
    // (one candidate recipient per row → correct grain). The delivery worker
    // never reads this column. Additive + NULLABLE.
    candidateReadAt: timestamp("candidate_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_notification_outbox_tenant_id_id").on(table.tenantId, table.id),
    // Primary worker query — partial to skip terminal rows.
    index("idx_notification_outbox_queue")
      .on(table.tenantId, table.status, table.priority, table.createdAt)
      .where(sql`status IN ('pending', 'processing')`),
    uniqueIndex("uniq_notification_outbox_dedup")
      .on(table.tenantId, table.dedupKey)
      .where(sql`dedup_key IS NOT NULL`),
    index("idx_notification_outbox_recipient_chrono").on(
      table.tenantId,
      table.recipientEmail,
      table.sentAt,
    ),
    // CAND-02 — the candidate Notifications feed: person-scoped by
    // recipient_candidate_id, newest-first by created_at. Partial to skip the
    // internal-directed rows that carry no candidate recipient.
    index("idx_notification_outbox_candidate_feed")
      .on(table.tenantId, table.recipientCandidateId, table.createdAt)
      .where(sql`recipient_candidate_id IS NOT NULL`),
    // Orphan recovery sweep — partial to skip rows that aren't stuck.
    index("idx_notification_outbox_orphan_sweep")
      .on(table.claimedAt)
      .where(sql`status = 'processing'`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type NotificationOutbox = typeof notificationOutbox.$inferSelect;
export type NewNotificationOutbox = typeof notificationOutbox.$inferInsert;
