import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  customType,
  index,
  uniqueIndex,
  unique,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// inet narrow type, same shape as audit_logs.ip_address.
const inet = customType<{ data: string; default: false }>({
  dataType() {
    return "inet";
  },
});

/**
 * Audit of every signed-link redemption attempt — successful or not.
 *
 * Append-only: split policies (tenant_isolation_select +
 * tenant_isolation_insert), no UPDATE/DELETE for authenticated. Same
 * shape as candidate_dedup_attempts / api_audit_logs / *_state_transitions.
 *
 * token_hash is SHA-256 of the redeemed token; we never store the raw
 * token (same discipline as partner_invitations.token_hash). The
 * PARTIAL UNIQUE (tenant_id, token_hash) WHERE successful=true is the
 * source-of-truth for one-time-use enforcement — a successful redemption
 * exists at most once per token. Failed attempts (bad signature, expired,
 * already_redeemed) can repeat without conflict; they're audit rows.
 *
 * No audit trigger attached — this IS the audit log for redemptions.
 */
export const signedLinkUses = pgTable(
  "signed_link_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    action: text("action").notNull(),
    subjectId: uuid("subject_id"),
    redeemedByIp: inet("redeemed_by_ip"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
    successful: boolean("successful").notNull(),
    failureReason: text("failure_reason"),
  },
  (table) => [
    unique("uniq_signed_link_uses_tenant_id_id").on(table.tenantId, table.id),
    // One SUCCESSFUL redemption per token — failed-attempt rows can repeat
    // without conflicting (the audit log needs to record every try).
    uniqueIndex("uniq_signed_link_uses_tenant_token")
      .on(table.tenantId, table.tokenHash)
      .where(sql`successful = true`),
    index("idx_signed_link_uses_tenant_chrono").on(table.tenantId, table.redeemedAt),
    pgPolicy("tenant_isolation_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
    // No UPDATE / DELETE policies — append-only under FORCE RLS.
  ],
).enableRLS();

export type SignedLinkUse = typeof signedLinkUses.$inferSelect;
export type NewSignedLinkUse = typeof signedLinkUses.$inferInsert;
