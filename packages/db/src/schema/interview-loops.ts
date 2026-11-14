import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * C2-F12 (0136) — named interview loops per tenant.
 *
 * Before 0136 a tenant had exactly ONE default loop (the rows of
 * tenant_interview_round_template). Rounds now carry a `loop_key`; this table
 * is the loop registry and gives each loop a stable uuid that an
 * applicability rule (template_assignments, kind 'interview_loop') can point
 * at. Every tenant has a 'default' loop (backfilled by 0136, ensured on first
 * use for tenants created later); it is also the fallback when no rule
 * matches. Loops are deactivated, never deleted. `loop_key` is immutable.
 */
export const interviewLoops = pgTable(
  "interview_loops",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    loopKey: text("loop_key").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_loops_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_interview_loops_tenant_key").on(table.tenantId, table.loopKey),
    check("interview_loops_key_check", sql`${table.loopKey} ~ '^[a-z0-9_]{1,64}$'`),
    check("interview_loops_label_check", sql`char_length(${table.label}) BETWEEN 1 AND 120`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type InterviewLoop = typeof interviewLoops.$inferSelect;
export type NewInterviewLoop = typeof interviewLoops.$inferInsert;
