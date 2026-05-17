import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  date,
  timestamp,
  customType,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";

// Inherit the inet shape used by audit_logs / signed_link_uses.
const inet = customType<{ data: string; default: false }>({
  dataType() {
    return "inet";
  },
});

/**
 * Offers of employment — separate from `applications` because one
 * application may have multiple offers (negotiation, re-issue after
 * cancel), each with its own audit trail.
 *
 * State machine (free-text `status`, same convention as ai_provider —
 * additive without an enum migration):
 *
 *   drafted → extended → accepted
 *           ↘          ↘ declined
 *           ↘           ↘ expired (sweep job)
 *           cancelled
 *
 * Only ONE offer per (tenant, application) can sit in 'extended' at a
 * time. Enforced by a partial UNIQUE index. The signed-link token hash
 * for the candidate accept flow is stored on the row itself
 * (`accept_signed_link_token_hash`) — the raw token only ever lives in
 * the email that goes out; we store the SHA-256 for lookup at redeem.
 *
 * Money: integer paise (1 INR = 100 paise) for the same anti-float-drift
 * reasoning as ai_usage_logs.cost_micros. Display layer divides by 100.
 *
 * Compound (tenant_id, *) FKs everywhere — same discipline as the rest
 * of the tenant-scoped schema. recipient_membership_id on offers is the
 * recruiter who drafted, not the candidate.
 *
 * RLS: standard single tenant_isolation. Audit trigger attached (offer
 * lifecycle is high-stakes — every transition surfaces in audit_logs).
 */
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    draftedByMembershipId: uuid("drafted_by_membership_id").notNull(),

    // Money in paise — bigint for headroom (multi-currency micros in
    // future without a column-type change).
    baseSalaryInrPaise: bigint("base_salary_inr_paise", { mode: "bigint" }).notNull(),
    variableTargetInrPaise: bigint("variable_target_inr_paise", { mode: "bigint" }),
    joiningBonusInrPaise: bigint("joining_bonus_inr_paise", { mode: "bigint" }),

    joiningDate: date("joining_date").notNull(),
    location: text("location").notNull(),
    expiryAt: timestamp("expiry_at", { withTimezone: true }).notNull(),
    termsHtml: text("terms_html"),

    status: text("status").notNull().default("drafted"),
    extendedAt: timestamp("extended_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declinedReason: text("declined_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),

    // Signed-link bookkeeping for the candidate accept flow.
    acceptSignedLinkTokenHash: text("accept_signed_link_token_hash"),
    acceptedFromIp: inet("accepted_from_ip"),
    acceptedUserAgent: text("accepted_user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_offers_tenant_id_id").on(table.tenantId, table.id),

    // ONE extended offer per application at a time. The partial predicate
    // is the workflow constraint; cancelled / accepted / declined slots
    // are unconstrained so revisions are free.
    uniqueIndex("uniq_offers_application_extended")
      .on(table.tenantId, table.applicationId)
      .where(sql`status = 'extended'`),

    // Per-application history, newest first — drawer renders an offer list.
    index("idx_offers_application_history").on(
      table.tenantId,
      table.applicationId,
      table.createdAt,
    ),

    // Expiry sweep candidates — partial so we don't index terminal rows.
    index("idx_offers_extended_expiry")
      .on(table.tenantId, table.expiryAt)
      .where(sql`status = 'extended'`),

    // Token-hash lookup for the candidate accept/decline POST handlers.
    // Sparse — only set after extend, so partial.
    index("idx_offers_accept_token_hash")
      .on(table.acceptSignedLinkTokenHash)
      .where(sql`accept_signed_link_token_hash IS NOT NULL`),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_offers_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.draftedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_offers_drafted_by",
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

export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
