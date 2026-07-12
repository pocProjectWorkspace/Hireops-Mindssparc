import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, unique, pgPolicy } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { notificationOutbox } from "./notification-outbox";

/**
 * Dev-only inspection mirror. LocalEmailProvider writes a row here
 * INSTEAD of sending real email — gives the dev a way to inspect
 * rendered HTML/text via SQL or a future tiny admin view.
 *
 * outbox_id back-references the notification_outbox row that drove
 * the "send". Single-column FK on .id (not compound (tenant_id, id))
 * for the same SET NULL reason called out in notification_outbox.ts.
 *
 * NOT audit-triggered. Conceptually a log; same exclusion as
 * ai_usage_logs / api_audit_logs / *_state_transitions.
 *
 * RLS: standard single tenant_isolation. Mutable (the worker
 * occasionally needs to update delivered_at; no real consumers
 * mutate today, but the convention matches partner_candidate_messages).
 */
export const devEmailOutbox = pgTable(
  "dev_email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject").notNull(),
    renderedHtml: text("rendered_html").notNull(),
    renderedText: text("rendered_text").notNull(),
    templateKey: text("template_key").notNull(),
    outboxId: uuid("outbox_id").references(() => notificationOutbox.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_dev_email_outbox_tenant_id_id").on(table.tenantId, table.id),
    index("idx_dev_email_outbox_tenant_chrono").on(table.tenantId, table.createdAt),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type DevEmailOutbox = typeof devEmailOutbox.$inferSelect;
export type NewDevEmailOutbox = typeof devEmailOutbox.$inferInsert;
