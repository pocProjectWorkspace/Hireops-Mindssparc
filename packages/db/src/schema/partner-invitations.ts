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
import { partnerOrgs } from "./partner-orgs";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { partnerUserRoleEnum } from "./partner-user-role";

/**
 * Token-based onboarding for partner users.
 *
 * Token-handling discipline (app-side, NOT enforced by the DB):
 *   - Generate 32 bytes, base64url-encode (~43 chars) — raw token.
 *   - Raw token goes in the email link, never logged, never persisted.
 *   - SHA-256(raw token) → token_hash → INSERT here.
 *   - Validation: SHA-256(incoming) → compare to stored hash.
 * Same pattern as how passwords are stored, but for one-time-use invites.
 *
 * expires_at: typically created_at + 7 days. consumed_at + revoked_at
 * track end-of-life. The partial unique on token_hash (WHERE
 * consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now())
 * means hash collisions only matter for *live* invitations — historical
 * dead ones can keep the same hash bucket without false-positive
 * conflict.
 *
 * RLS: standard single tenant_isolation. Audit trigger attached.
 */
export const partnerInvitations = pgTable(
  "partner_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerOrgId: uuid("partner_org_id").notNull(),
    email: text("email").notNull(),
    intendedRole: partnerUserRoleEnum("intended_role").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByUserId: uuid("consumed_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_partner_invitations_tenant_id_id").on(table.tenantId, table.id),
    // Partial unique on live tokens — primary redemption lookup is by
    // hash; conflicts only matter while the invitation is valid.
    //
    // NOTE: we'd like to add `AND expires_at > now()` to the predicate
    // but Postgres rejects non-IMMUTABLE functions in partial index
    // predicates. The validation flow already checks expires_at at
    // redemption time; expired-but-not-revoked tokens with the same
    // hash would conflict here, but the conflict surface is tiny
    // (two invitations to the same email at the same minute) and
    // recoverable (revoke + reissue).
    uniqueIndex("uniq_partner_invitations_live_token")
      .on(table.tenantId, table.tokenHash)
      .where(sql`consumed_at IS NULL AND revoked_at IS NULL`),
    index("idx_partner_invitations_org_email").on(table.tenantId, table.partnerOrgId, table.email),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_partner_invitations_partner_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.createdByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_partner_invitations_created_by",
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

export type PartnerInvitation = typeof partnerInvitations.$inferSelect;
export type NewPartnerInvitation = typeof partnerInvitations.$inferInsert;
