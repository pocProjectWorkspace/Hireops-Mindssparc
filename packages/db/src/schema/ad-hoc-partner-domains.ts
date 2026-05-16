import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
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

/**
 * Email-domain → partner_org mapping for the email-intake parser.
 *
 * Partial unique on (tenant_id, domain) WHERE active = true means two
 * tenants can independently empanel `acme-recruiting.com` (each gets
 * their own active row) but within a single tenant only one partner_org
 * can own a domain at a time.
 *
 * partner_org_id must reference a partner_org with tier='ad_hoc'. The
 * DB doesn't enforce this — cross-table CHECK isn't expressible
 * standard SQL. Enforced at the application layer; see the test in
 * apps/api/test/db-partner-a.test.ts that documents the current
 * behaviour (empanelled-tier inserts succeed at the DB level).
 *
 * RLS: standard single tenant_isolation. Audit trigger attached.
 */
export const adHocPartnerDomains = pgTable(
  "ad_hoc_partner_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerOrgId: uuid("partner_org_id").notNull(),
    domain: text("domain").notNull(),
    defaultConsentText: text("default_consent_text").notNull(),
    dailyQuota: integer("daily_quota").notNull().default(50),
    defaultContactEmail: text("default_contact_email").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_ad_hoc_partner_domains_tenant_id_id").on(table.tenantId, table.id),
    uniqueIndex("uniq_ad_hoc_domain_per_tenant")
      .on(table.tenantId, table.domain)
      .where(sql`active = true`),
    index("idx_ad_hoc_partner_org_active").on(table.tenantId, table.partnerOrgId, table.active),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_ad_hoc_partner_org",
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

export type AdHocPartnerDomain = typeof adHocPartnerDomains.$inferSelect;
export type NewAdHocPartnerDomain = typeof adHocPartnerDomains.$inferInsert;
