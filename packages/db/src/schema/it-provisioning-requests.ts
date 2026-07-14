import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
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
 * it_provisioning_requests — handoff to the IT persona (architecture.md
 * §5.1; requirements.md §7.3 "IT provisioning queue"). One row per
 * provisioned resource (laptop, email account, AD/Okta, Slack/Teams,
 * role-based app access). `resource_type` is free text — the app
 * catalogue grows. `details` (jsonb) carries specs / the role-based app
 * list. `scim_sync_ref` records the SCIM push where access is automated
 * (requirements.md §7.3 "Access provisioning via SCIM").
 *
 * `status` is text + CHECK (reality #114).
 */
export const itProvisioningRequests = pgTable(
  "it_provisioning_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    resourceType: text("resource_type").notNull(),
    details: jsonb("details"),
    status: text("status").notNull().default("requested"),
    assignedItMembershipId: uuid("assigned_it_membership_id"),
    scimSyncRef: text("scim_sync_ref"),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_it_provisioning_requests_tenant_id_id").on(table.tenantId, table.id),

    index("idx_it_provisioning_requests_case").on(table.tenantId, table.caseId),
    // The IT persona work-queue.
    index("idx_it_provisioning_requests_status").on(table.tenantId, table.status),

    check(
      "it_provisioning_requests_status_check",
      sql`${table.status} IN ('requested', 'in_progress', 'provisioned', 'failed', 'cancelled')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [onboardingCases.tenantId, onboardingCases.id],
      name: "fk_it_provisioning_requests_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.assignedItMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_it_provisioning_requests_assigned_it",
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

export type ItProvisioningRequest = typeof itProvisioningRequests.$inferSelect;
export type NewItProvisioningRequest = typeof itProvisioningRequests.$inferInsert;
