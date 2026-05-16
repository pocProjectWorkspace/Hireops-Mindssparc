import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { partnerOrgs } from "./partner-orgs";
import { partnerUserRoleEnum } from "./partner-user-role";

/**
 * Humans who belong to partner_orgs. SEPARATE from public.users.
 *
 * user_id references auth.users(id) — the same identity provider as
 * tenant-internal users use, but a human registered through the partner
 * portal lives ONLY in partner_users; one registered through internal
 * onboarding lives ONLY in tenant_user_memberships. A human is internal
 * OR partner in a given tenant, never both. The cross-table CHECK that
 * would enforce this isn't expressible in standard SQL; enforced at the
 * application layer + a periodic audit query (see HANDOVER §4 partner
 * realities).
 *
 * (tenant_id, user_id) UNIQUE — one partner_users row per auth identity
 * per tenant. A single human can still be partner_users[tenant_A] and
 * partner_users[tenant_B] simultaneously; partner identity is tenant-scoped.
 *
 * The FK from user_id to auth.users(id) lives in a future cross-schema
 * migration (same pattern as public.users.id → auth.users.id, which
 * ships as a hand-written ALTER outside Drizzle's schema graph).
 *
 * RLS: standard single tenant_isolation policy. Audit trigger attached.
 */
export const partnerUsers = pgTable(
  "partner_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerOrgId: uuid("partner_org_id").notNull(),
    userId: uuid("user_id").notNull(),
    fullName: text("full_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    role: partnerUserRoleEnum("role").notNull(),
    active: boolean("active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_partner_users_tenant_id_id").on(table.tenantId, table.id),
    // One partner_users row per (tenant, auth user).
    uniqueIndex("uniq_partner_users_tenant_user").on(table.tenantId, table.userId),
    index("idx_partner_users_org_active").on(table.tenantId, table.partnerOrgId, table.active),
    index("idx_partner_users_email").on(table.tenantId, table.email),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_partner_users_partner_org",
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

export type PartnerUser = typeof partnerUsers.$inferSelect;
export type NewPartnerUser = typeof partnerUsers.$inferInsert;
