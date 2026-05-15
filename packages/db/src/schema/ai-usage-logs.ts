import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Per-tenant LLM call ledger (cost + usage + outcome).
 *
 * Append-only. Two policies for `authenticated`:
 *   - tenant_isolation_select — read your own tenant's rows
 *   - tenant_isolation_insert — only insert rows that carry your tenant_id
 * No UPDATE/DELETE policies → under FORCE RLS those operations match zero
 * rows for authenticated. Service-role can still rewrite history (admin
 * escape hatch). Same shape as requisition_state_transitions and
 * approval_decisions.
 *
 * No audit trigger attached. ai_usage_logs IS the log — auditing every
 * insert would create a 1:1 noise stream. Same exclusion logic that keeps
 * the trigger off application_state_transitions, approval_decisions, etc.
 *
 * cost_micros is integer micros where 1 USD = 1,000,000 micros. Avoids
 * float drift and preserves precision at sub-cent call sizes (a 100-token
 * Sonnet completion costs ~300 micros = $0.0003, which would round to 0
 * cents and destroy the per-call signal).
 *
 * provider / model / feature are free text — provider names follow
 * 'anthropic' | 'openai' | 'local' today and 'feature' is caller-supplied
 * ('resume_parse', 'jd_score', 'screening_summary', …). If usage stabilises
 * a CHECK constraint can be added later; for Wave 1 the cost is cheaper
 * to keep open.
 */
export const aiUsageLogs = pgTable(
  "ai_usage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    feature: text("feature").notNull(),
    actorMembershipId: uuid("actor_membership_id"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costMicros: bigint("cost_micros", { mode: "bigint" }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    requestId: text("request_id"),
    succeeded: boolean("succeeded").notNull().default(true),
    errorCode: text("error_code"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_ai_usage_logs_tenant_chrono").on(table.tenantId, table.createdAt),
    index("idx_ai_usage_logs_tenant_feature").on(table.tenantId, table.feature, table.createdAt),
    index("idx_ai_usage_logs_tenant_model").on(
      table.tenantId,
      table.provider,
      table.model,
      table.createdAt,
    ),
    unique("uniq_ai_usage_logs_tenant_id_id").on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.actorMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_ai_usage_logs_actor",
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
    // No UPDATE / DELETE policies — under FORCE RLS authenticated callers
    // match zero rows for those operations. Append-only contract.
  ],
).enableRLS();

export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type NewAiUsageLog = typeof aiUsageLogs.$inferInsert;
