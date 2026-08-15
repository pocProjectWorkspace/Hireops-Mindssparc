import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  bigint,
  timestamp,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { partnerOrgs } from "./partner-orgs";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * P2 — the commercial terms behind a partner org (partner-data-model
 * "partner_msa"). This is the keystone the completion audit called out: its
 * absence blocked the exclusivity-window override, fee accrual, and the
 * partner-scorecard / cost-per-hire reports.
 *
 * One LIVE row per org (partial unique WHERE effective_to IS NULL); changing
 * terms closes the old row (effective_to) and opens a new one, so history is
 * queryable and a fee accrued under old terms still points at the row it was
 * computed from.
 *
 * fee_model is text + CHECK, the offers.status "additive-without-enum"
 * convention: percentage_ctc / flat_per_hire for the POC; flat_per_grade is
 * the documented Wave-3 addition and lands by widening the CHECK.
 *
 * RLS: standard tenant_isolation (internal-staff surface; the partner portal
 * reads DERIVED fee rows, never the MSA itself). FORCE + audit trigger in the
 * migration, matching the other partner tables.
 */
export const partnerMsa = pgTable(
  "partner_msa",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerOrgId: uuid("partner_org_id").notNull(),
    feeModel: text("fee_model").notNull(),
    /** percentage_ctc: percent of the accepted offer's annual base. */
    feePercent: numeric("fee_percent", { precision: 5, scale: 2 }),
    /** flat_per_hire: minor units (paise) in fee_currency. */
    flatFeeMinor: bigint("flat_fee_minor", { mode: "bigint" }),
    feeCurrency: text("fee_currency").notNull().default("INR"),
    /**
     * Ownership-claim exclusivity window. partnerSubmitCandidate falls back
     * to its hardcoded 90 when the org has no live MSA (the pre-P2 default).
     */
    exclusivityWindowDays: integer("exclusivity_window_days").notNull().default(90),
    exclusivityScope: text("exclusivity_scope").notNull().default("org_wide"),
    probationHoldbackPercent: numeric("probation_holdback_percent", { precision: 5, scale: 2 })
      .notNull()
      .default("25"),
    replacementGuaranteeDays: integer("replacement_guarantee_days").notNull().default(90),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = the live row. Closing it is how terms change, never UPDATE-in-place. */
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_partner_msa_tenant_id_id").on(table.tenantId, table.id),
    uniqueIndex("uniq_partner_msa_live")
      .on(table.tenantId, table.partnerOrgId)
      .where(sql`effective_to IS NULL`),
    index("idx_partner_msa_org").on(table.tenantId, table.partnerOrgId, table.effectiveFrom),
    check(
      "partner_msa_fee_model_check",
      sql`${table.feeModel} IN ('percentage_ctc', 'flat_per_hire')`,
    ),
    // The fee model must carry its own operand — a percentage MSA without a
    // percent (or a flat MSA without an amount) is unrepresentable.
    check(
      "partner_msa_fee_operand_check",
      sql`(${table.feeModel} = 'percentage_ctc' AND ${table.feePercent} IS NOT NULL)
       OR (${table.feeModel} = 'flat_per_hire' AND ${table.flatFeeMinor} IS NOT NULL)`,
    ),
    check(
      "partner_msa_exclusivity_scope_check",
      sql`${table.exclusivityScope} IN ('org_wide', 'req_only')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_partner_msa_partner_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.createdByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_partner_msa_created_by",
    }).onDelete("set null"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type PartnerMsa = typeof partnerMsa.$inferSelect;
export type NewPartnerMsa = typeof partnerMsa.$inferInsert;
