import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, pgPolicy } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Per-tenant ledger of user-invoked assistant actions (IRIS-A1).
 *
 * Provenance for every transaction a user-invoked assistant ("iris") executed
 * on the user's behalf, AFTER the user confirmed a resolved preview. The row is
 * written by iris.execute the instant the underlying gated procedure commits, so
 * an entity created via the assistant carries a durable "who confirmed what,
 * when" record. The future "AI-assisted" pill reads this back (iris.getProvenance):
 * a requisition created via Iris has a row here; a human-created one does not.
 *
 * HONESTY: this table records provenance ONLY. It never carries a write path of
 * its own — the actual mutation runs through the SAME gated tRPC procedure a
 * human uses (its own RLS + withAudit fire). This row is the audit-of-intent
 * layer on top, not a shortcut around it.
 *
 * Append-only, modelled end-to-end on ai_usage_logs / api_audit_logs. Two
 * policies for `authenticated`:
 *   - tenant_isolation_select — read your own tenant's rows
 *   - tenant_isolation_insert — only insert rows that carry your tenant_id
 * No UPDATE/DELETE policies → under FORCE RLS those operations match zero rows
 * for authenticated. FORCE is added by the companion migration (drizzle's
 * .enableRLS() emits ENABLE, never FORCE).
 *
 * No audit trigger attached. assistant_actions IS a log — auditing every insert
 * would create a 1:1 noise stream. Same exclusion that keeps the trigger off
 * ai_usage_logs / api_audit_logs and the *_state_transitions tables.
 *
 * confirmed_by_user_id is the auth.users id (ctx.userId / JWT sub) of the human
 * who confirmed the action. No modelled FK — auth.users is cross-schema and
 * Drizzle can't represent it (same treatment as api_audit_logs.actor_user_id).
 * entity_type / entity_id are a loose (nullable) reference to the created or
 * changed entity; intentionally NOT a hard FK so this ledger never blocks or
 * cascades against the domain tables it merely annotates.
 */
export const assistantActions = pgTable(
  "assistant_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    assistant: text("assistant").notNull().default("iris"),
    actionId: text("action_id").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    confirmedByUserId: uuid("confirmed_by_user_id"),
    status: text("status").notNull().default("executed"),
    paramsJson: jsonb("params_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_assistant_actions_tenant_chrono").on(table.tenantId, table.createdAt),
    index("idx_assistant_actions_tenant_entity").on(
      table.tenantId,
      table.entityType,
      table.entityId,
    ),
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
    // No UPDATE / DELETE policies — under FORCE RLS authenticated callers
    // match zero rows for those operations. Append-only contract.
  ],
).enableRLS();

export type AssistantAction = typeof assistantActions.$inferSelect;
export type NewAssistantAction = typeof assistantActions.$inferInsert;
