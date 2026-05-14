import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { requisitions } from "./requisitions";
import { knockoutTypeEnum } from "./knockout-type";

/**
 * Knockout questions per requisition. Per requirements.md §5.4 — these
 * gate submission validity (a candidate failing a required knockout is
 * disqualified at application time, not at review time).
 *
 * threshold_value is jsonb because its shape depends on type:
 *   boolean      → { required: true }
 *   numeric_min  → { min: <number> }
 *   numeric_max  → { max: <number> }
 *   enum         → { allowed: [<string>, ...] }
 *
 * source describes where the answer comes from at evaluation time:
 *   parsed_cv          — extracted from CV during apply flow
 *   candidate_asserted — candidate self-reports on the apply form
 *   partner_asserted   — partner pre-attests on the candidate's behalf
 *
 * order_index is the display order on the apply form. Index on
 * (requisition_id, order_index) makes the ordered fetch a single index scan.
 */
export const requisitionKnockouts = pgTable(
  "requisition_knockouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").notNull(),
    questionText: text("question_text").notNull(),
    type: knockoutTypeEnum("type").notNull(),
    thresholdValue: jsonb("threshold_value").notNull(),
    source: text("source").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_req_knockouts_order").on(table.requisitionId, table.orderIndex),
    unique("uniq_requisition_knockouts_tenant_id_id").on(table.tenantId, table.id),
    check(
      "req_knockout_source_check",
      sql`${table.source} IN ('parsed_cv', 'candidate_asserted', 'partner_asserted')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_requisition_knockouts_requisition",
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type RequisitionKnockout = typeof requisitionKnockouts.$inferSelect;
export type NewRequisitionKnockout = typeof requisitionKnockouts.$inferInsert;
