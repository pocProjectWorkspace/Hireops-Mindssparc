import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { agentRuns } from "./agent-runs";

/**
 * Inbound candidate messages — landing pad for the Resend webhook.
 *
 * to_email is the per-tenant routing address shape:
 *   replies+{tenant_slug}+{ref}@hireops.app
 * where ref encodes the application_id + correlation key. The webhook
 * resolves ref to application_id; rows where resolution fails leave
 * application_id NULL and surface to recruiters via a review queue
 * (later ticket).
 *
 * resend_message_id is Resend's provider-side id, used for idempotency.
 * The partial unique index lets the webhook safely retry without
 * double-inserting; NULL rows (manual inserts, parser fallbacks) are
 * exempt from the uniqueness.
 *
 * processed_at is the marker that this row has been handed to an agent.
 * agent_run_id is populated when a 'message_received' agent picks it up.
 *
 * FK strategy: application_id and agent_run_id are both nullable + SET
 * NULL — single-column FKs per notification_outbox HANDOVER #63 pattern
 * (compound + NOT NULL tenant_id is rejected by Postgres for SET NULL).
 */
export const candidateInboundMessages = pgTable(
  "candidate_inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id"),
    fromEmail: text("from_email").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    resendMessageId: text("resend_message_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    agentRunId: uuid("agent_run_id"),
  },
  (table) => [
    unique("uniq_candidate_inbound_messages_tenant_id_id").on(table.tenantId, table.id),
    // Dedup on Resend provider id, partial so manual inserts are exempt.
    uniqueIndex("uniq_candidate_inbound_messages_resend_id")
      .on(table.tenantId, table.resendMessageId)
      .where(sql`resend_message_id IS NOT NULL`),
    // "Unprocessed inbound messages" query for the agent dispatcher.
    index("idx_candidate_inbound_messages_unprocessed").on(
      table.tenantId,
      table.processedAt,
      table.receivedAt,
    ),
    foreignKey({
      columns: [table.applicationId],
      foreignColumns: [applications.id],
      name: "fk_candidate_inbound_messages_application",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.agentRunId],
      foreignColumns: [agentRuns.id],
      name: "fk_candidate_inbound_messages_agent_run",
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

export type CandidateInboundMessage = typeof candidateInboundMessages.$inferSelect;
export type NewCandidateInboundMessage = typeof candidateInboundMessages.$inferInsert;
