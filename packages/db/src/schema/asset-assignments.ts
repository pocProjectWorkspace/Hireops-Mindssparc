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
import { onboardingCases } from "./onboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * asset_assignments — physical/logical assets issued to a new hire
 * (architecture.md §5.1: "laptop, peripherals, badge"). `asset_type` and
 * `asset_tag` are free text (inventory tag / serial). `status` is
 * text + CHECK (reality #114). Return handling proper belongs to the
 * offboarding pillar (out of scope here); the 'returned' status exists so
 * an asset re-issued mid-onboarding can be tracked.
 */
export const assetAssignments = pgTable(
  "asset_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    assetType: text("asset_type").notNull(),
    assetTag: text("asset_tag"),
    description: text("description"),
    status: text("status").notNull().default("requested"),

    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    assignedByMembershipId: uuid("assigned_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_asset_assignments_tenant_id_id").on(table.tenantId, table.id),

    index("idx_asset_assignments_case").on(table.tenantId, table.caseId),
    index("idx_asset_assignments_status").on(table.tenantId, table.status),

    check(
      "asset_assignments_status_check",
      sql`${table.status} IN ('requested', 'allocated', 'assigned', 'returned', 'lost')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [onboardingCases.tenantId, onboardingCases.id],
      name: "fk_asset_assignments_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.assignedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_asset_assignments_assigned_by",
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

export type AssetAssignment = typeof assetAssignments.$inferSelect;
export type NewAssetAssignment = typeof assetAssignments.$inferInsert;
