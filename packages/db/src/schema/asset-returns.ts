import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { offboardingCases } from "./offboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * asset_returns — hardware/asset return tracking for a departure
 * (architecture.md §5.1 "asset_returns"; requirements.md §8.2 "Laptop,
 * peripherals, ID card, books, devices. Each tracked, signed-off by IT" and
 * §8.3 "Hardware return confirmation — IT confirms before final settlement
 * is released").
 *
 * This is the RETURN side of the lifecycle and is deliberately its own table,
 * distinct from onboarding's asset_assignments (the ISSUE side); the two are
 * not FK-linked in OFFBOARD-01 (no employee/asset-registry table joins them
 * yet — a reconciliation seam for a later ticket).
 *
 * `status` text + CHECK (NOT pgEnum) — HANDOVER reality #114.
 * `received_by_membership_id` is the IT/HR person who signed off the return.
 */
export const assetReturns = pgTable(
  "asset_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    assetType: text("asset_type").notNull(),
    assetTag: text("asset_tag"),
    status: text("status").notNull().default("pending"),

    returnedAt: timestamp("returned_at", { withTimezone: true }),
    receivedByMembershipId: uuid("received_by_membership_id"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_asset_returns_tenant_id_id").on(table.tenantId, table.id),

    index("idx_asset_returns_case").on(table.tenantId, table.caseId),
    index("idx_asset_returns_status").on(table.tenantId, table.status),

    check(
      "asset_returns_status_check",
      sql`${table.status} IN ('pending', 'returned', 'written_off', 'lost')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [offboardingCases.tenantId, offboardingCases.id],
      name: "fk_asset_returns_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.receivedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_asset_returns_received_by",
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

export type AssetReturn = typeof assetReturns.$inferSelect;
export type NewAssetReturn = typeof assetReturns.$inferInsert;
