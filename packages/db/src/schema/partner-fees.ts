import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  jsonb,
  index,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { partnerOrgs } from "./partner-orgs";
import { partnerMsa } from "./partner-msa";
import { applications } from "./applications";

/**
 * P2 — one fee accrual per partner-sourced HIRE (partner-data-model
 * "partner_fees"). Created by the offer-accept side effects when the accepted
 * application carries a source_partner_id and the org has a live MSA;
 * msa_snapshot freezes the terms the fee was computed under, so a later terms
 * change can never rewrite an accrued fee.
 *
 * status is the POC read-only-commercials lifecycle: accrued (probation /
 * holdback window running) → payable (holdback released) → paid; disputed is
 * the parking state. Invoicing/AP integration is documented Wave-3 scope —
 * there is deliberately no invoice table to point at yet.
 *
 * FKs: the org FK is RESTRICT, not cascade — fee rows are financial records
 * and must outlive an org deletion attempt (deactivate the org instead). One
 * fee per application (unique). offer_id is informational (offers carries no
 * (tenant_id, id) unique to composite-FK against).
 *
 * RLS: standard tenant_isolation; the partner portal surfaces an org-scoped
 * projection via partnerProcedure (org predicate in the WHERE, as everywhere).
 * FORCE + audit trigger in the migration.
 */
export const partnerFees = pgTable(
  "partner_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerOrgId: uuid("partner_org_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    offerId: uuid("offer_id"),
    msaId: uuid("msa_id"),
    msaSnapshot: jsonb("msa_snapshot").notNull(),
    feeMinor: bigint("fee_minor", { mode: "bigint" }).notNull(),
    feeCurrency: text("fee_currency").notNull().default("INR"),
    status: text("status").notNull().default("accrued"),
    holdbackReleaseAt: timestamp("holdback_release_at", { withTimezone: true }),
    hiredAt: timestamp("hired_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_partner_fees_tenant_id_id").on(table.tenantId, table.id),
    // One fee per hire — a retried accept must never double-accrue.
    unique("uniq_partner_fees_application").on(table.tenantId, table.applicationId),
    index("idx_partner_fees_org_status").on(table.tenantId, table.partnerOrgId, table.status),
    check(
      "partner_fees_status_check",
      sql`${table.status} IN ('accrued', 'payable', 'paid', 'disputed')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_partner_fees_partner_org",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_partner_fees_application",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.msaId],
      foreignColumns: [partnerMsa.tenantId, partnerMsa.id],
      name: "fk_partner_fees_msa",
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

export type PartnerFee = typeof partnerFees.$inferSelect;
export type NewPartnerFee = typeof partnerFees.$inferInsert;
