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
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";

/**
 * Outbox for external Workday syncs — parallel to notification_outbox
 * but with a distinct shape (Workday logical-model JSON payloads, plus
 * a `simulated_response` slot for Wave 1 / a `provider_message_id` slot
 * for Phase 3 when the real connector lands).
 *
 * Drained by apps/workers (workday-simulation-drain.ts) which, in Wave 1,
 * generates a deterministic mock response carrying an explicit
 * `simulation_notes` string so anyone inspecting the Integration Health
 * screen sees it's a simulation, not real.
 *
 * `business_key` is the idempotency key. For hire_employee events:
 *   "hire:application:{application_id}"
 * Multiple application-driven Workday events for the same application
 * (e.g. a future "terminate_employee") use a different prefix to avoid
 * collision.
 *
 * RLS: standard single tenant_isolation. NO audit trigger — this IS the
 * log of external syncs (same posture as notification_outbox /
 * ai_usage_logs / api_audit_logs).
 */
export const workdaySyncOutbox = pgTable(
  "workday_sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    businessKey: text("business_key").notNull(),
    subjectApplicationId: uuid("subject_application_id"),
    payload: jsonb("payload").notNull(),

    status: text("status").notNull().default("pending"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),

    simulatedResponse: jsonb("simulated_response"),
    simulatedAt: timestamp("simulated_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_workday_sync_outbox_tenant_id_id").on(table.tenantId, table.id),

    // Idempotency: one row per (tenant, business_key). Re-enqueue of the
    // same event hits 23505 and the caller treats it as already queued.
    uniqueIndex("uniq_workday_sync_outbox_business_key").on(
      table.tenantId,
      table.businessKey,
    ),

    // Worker drain query — partial to skip terminal rows.
    index("idx_workday_sync_outbox_queue")
      .on(table.tenantId, table.status, table.createdAt)
      .where(sql`status IN ('pending', 'processing')`),

    // Integration Health filter pane — newest events per type.
    index("idx_workday_sync_outbox_type_chrono").on(
      table.tenantId,
      table.eventType,
      table.createdAt,
    ),

    // Optional back-reference for the Integration Health row expansion
    // ("which application drove this?"). Compound FK, ON DELETE SET NULL
    // would null tenant_id (same trap that hit Module 3); use a plain
    // single-column FK on .id like notification_outbox.recipient_*.
    // Actually no — applications is mandatory tenant-scoped and we DO want
    // tenant-isolation FK integrity here. Keep the compound but use NO
    // ACTION (the application is never hard-deleted in practice; logical
    // cleanup goes through redaction).
    foreignKey({
      columns: [table.tenantId, table.subjectApplicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_workday_sync_outbox_application",
    }),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type WorkdaySyncOutbox = typeof workdaySyncOutbox.$inferSelect;
export type NewWorkdaySyncOutbox = typeof workdaySyncOutbox.$inferInsert;
