import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  foreignKey,
  pgPolicy,
  check,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * ask_data_questions — the "Ask your data" question log (PC-21, migration 0131).
 *
 * One row per ANSWERED question: who asked (membership + their roles at the
 * time), what they typed (null for a chip click), and what it resolved to
 * (catalog intent + effective params). It feeds "Your recent" (the asker's
 * own rows), "Popular in your team" (intent counts over the last 30 days
 * among askers sharing a role with the viewer — intents only, never another
 * person's text) and the admin "top questions" view.
 *
 * A LOG, modelled on assistant_actions / pii_access_log: append-only under
 * FORCE RLS (split tenant_isolation_select + tenant_isolation_insert, no
 * UPDATE / DELETE for authenticated), no audit_record_change trigger (a log
 * of reads does not need a change stream about itself).
 *
 * `intent` is text, not an enum: the catalog lives in code
 * (packages/api-types/src/ask-data.ts) and widening it must not need DDL.
 */
export const askDataQuestions = pgTable(
  "ask_data_questions",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    askerRoles: text("asker_roles")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    question: text("question"),
    intent: text("intent").notNull(),
    params: jsonb("params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_ask_data_questions_member_chrono").on(
      table.tenantId,
      table.membershipId,
      table.createdAt.desc(),
    ),
    index("idx_ask_data_questions_tenant_chrono").on(table.tenantId, table.createdAt.desc()),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "ask_data_questions_tenant_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_ask_data_questions_membership",
    }).onDelete("cascade"),
    check("ask_data_questions_source_check", sql`${table.source} IN ('chip', 'matched', 'ai')`),
    check(
      "ask_data_questions_question_len_check",
      sql`${table.question} IS NULL OR char_length(${table.question}) <= 500`,
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
    // No UPDATE / DELETE policies — append-only under FORCE RLS.
  ],
).enableRLS();

export type AskDataQuestion = typeof askDataQuestions.$inferSelect;
export type NewAskDataQuestion = typeof askDataQuestions.$inferInsert;
