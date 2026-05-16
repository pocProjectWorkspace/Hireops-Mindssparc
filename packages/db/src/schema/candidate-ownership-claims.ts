import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { persons } from "./persons";
import { partnerOrgs } from "./partner-orgs";
import { partnerUsers } from "./partner-users";
import { applications } from "./applications";
import { ownershipClaimStatusEnum } from "./ownership-claim-status";

/**
 * The 6-month-window state machine. One active claim per (tenant, person),
 * enforced by the partial-unique index. Concurrent submission attempts
 * surface as constraint violations the app turns into "candidate already
 * claimed."
 *
 * status is denormalised from expires_at + released_at + superseded_at.
 *
 * The partial unique uses ONLY `status = 'active'` — Postgres rejects
 * non-IMMUTABLE functions like now() in partial index predicates, so we
 * can't include `expires_at > now()`. That means a row with
 * status='active' but expires_at < now() WILL still block a new claim
 * until the background sweep flips status to 'expired'. The sweep is
 * load-bearing now (was a nice-to-have when the index could check
 * expires_at itself). Run frequency: daily is enough for the 6-month
 * window; expiry boundaries don't need to-the-second accuracy.
 *
 * superseded_by_claim_id is the chain pointer: when claim A releases and
 * claim B takes over, B's row is the new active claim and A.status =
 * 'superseded' with A.superseded_by_claim_id = B.id. Compound self-FK
 * keeps the chain tenant-local.
 *
 * RLS: standard single tenant_isolation. Audit trigger attached — every
 * release / supersede / expire matters for partner attribution disputes.
 */
export const candidateOwnershipClaims = pgTable(
  "candidate_ownership_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    partnerOrgId: uuid("partner_org_id").notNull(),
    claimedViaPartnerUserId: uuid("claimed_via_partner_user_id"),
    claimedViaApplicationId: uuid("claimed_via_application_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: ownershipClaimStatusEnum("status").notNull().default("active"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedReason: text("released_reason"),
    supersededByClaimId: uuid("superseded_by_claim_id"),
  },
  (table) => [
    unique("uniq_candidate_ownership_claims_tenant_id_id").on(table.tenantId, table.id),
    // THE constraint that prevents two active claims for the same person.
    // See file-level comment for why the predicate is status-only.
    uniqueIndex("uniq_active_claim_per_person")
      .on(table.tenantId, table.personId)
      .where(sql`status = 'active'`),
    index("idx_claims_partner_status_claimed").on(
      table.tenantId,
      table.partnerOrgId,
      table.status,
      table.claimedAt,
    ),
    // Expiry sweep query path. Partial — only active rows matter.
    index("idx_claims_active_expiry")
      .on(table.tenantId, table.expiresAt)
      .where(sql`status = 'active'`),
    foreignKey({
      columns: [table.tenantId, table.personId],
      foreignColumns: [persons.tenantId, persons.id],
      name: "fk_claims_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_claims_partner_org",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.claimedViaPartnerUserId],
      foreignColumns: [partnerUsers.tenantId, partnerUsers.id],
      name: "fk_claims_partner_user",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.tenantId, table.claimedViaApplicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_claims_application",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.tenantId, table.supersededByClaimId],
      foreignColumns: [table.tenantId, table.id],
      name: "fk_claims_superseded_by",
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

export type CandidateOwnershipClaim = typeof candidateOwnershipClaims.$inferSelect;
export type NewCandidateOwnershipClaim = typeof candidateOwnershipClaims.$inferInsert;
