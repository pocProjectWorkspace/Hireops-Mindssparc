import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { approvalMatrices } from "./approval-matrices";

/**
 * Resolved approval chain for a specific approval instance. Immutable
 * once created: changes to the source matrix don't retroactively
 * mutate in-flight chains.
 *
 * matrix_version_snapshot is a copy of approval_matrices.rules at chain
 * creation time. Belt-and-braces: if the matrix is mutated despite
 * being effective-dated, this preserves exactly what we resolved
 * against.
 *
 * resolved_steps is an ordered jsonb array. Each step descriptor:
 *   { step_index, approver_kind, approver_ref, required, order_index }
 * where approver_kind is 'membership' | 'role' | 'external' and
 * approver_ref is interpreted per kind (membership id, role enum value,
 * or opaque external string).
 *
 * RLS: standard tenant_isolation. Trigger: audit_record_change() fires.
 */
export const approvalChains = pgTable(
  "approval_chains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    matrixId: uuid("matrix_id").notNull(),
    matrixVersionSnapshot: jsonb("matrix_version_snapshot").notNull(),
    resolvedSteps: jsonb("resolved_steps").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // No updated_at — chains are immutable.
  },
  (table) => [
    unique("uniq_approval_chains_tenant_id_id").on(table.tenantId, table.id),
    // "Show me chains derived from this matrix" for audit + analytics.
    index("idx_approval_chains_by_matrix").on(table.tenantId, table.matrixId, table.createdAt),
    foreignKey({
      columns: [table.tenantId, table.matrixId],
      foreignColumns: [approvalMatrices.tenantId, approvalMatrices.id],
      name: "fk_approval_chains_matrix",
    }).onDelete("restrict"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type ApprovalChain = typeof approvalChains.$inferSelect;
export type NewApprovalChain = typeof approvalChains.$inferInsert;
