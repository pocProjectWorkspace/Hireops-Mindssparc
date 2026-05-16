import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  char,
  timestamp,
  index,
  unique,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { partnerTierEnum } from "./partner-tier";

/**
 * Empanelled or ad-hoc partner organisation. Tenant-scoped — a partner
 * org in tenant A is a separate row from the "same" partner org in
 * tenant B (per ADR-002 / multi-tenancy doc; vendors who serve multiple
 * Kyndryl-style customers get one row per customer-tenant).
 *
 * tier governs all downstream behaviour: empanelled gets a portal +
 * partner_users + assignments; ad_hoc only ever has rows in
 * ad_hoc_partner_domains and is attributed via inbound sender domain.
 *
 * legal_entity_name / country / primary_contact_* are Wave 2 commercial
 * surface (MSA prep + invoicing). Captured now so the onboarding form
 * doesn't have to retrofit them.
 *
 * RLS: standard single tenant_isolation policy. Audit trigger attached.
 */
export const partnerOrgs = pgTable(
  "partner_orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tier: partnerTierEnum("tier").notNull(),
    legalEntityName: text("legal_entity_name"),
    country: char("country", { length: 2 }),
    primaryContactEmail: text("primary_contact_email"),
    primaryContactPhone: text("primary_contact_phone"),
    active: boolean("active").notNull().default(true),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_partner_orgs_tenant_id_id").on(table.tenantId, table.id),
    index("idx_partner_orgs_tenant_tier_active").on(table.tenantId, table.tier, table.active),
    index("idx_partner_orgs_tenant_name").on(table.tenantId, table.name),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type PartnerOrg = typeof partnerOrgs.$inferSelect;
export type NewPartnerOrg = typeof partnerOrgs.$inferInsert;
