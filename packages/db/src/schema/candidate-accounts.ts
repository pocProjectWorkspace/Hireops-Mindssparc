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
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { persons } from "./persons";

/**
 * Candidate login identities (Wave C, CAND-01). SEPARATE from public.users
 * AND partner_users — the third and final identity tier.
 *
 * user_id references auth.users(id) — the same identity provider internal
 * and partner humans use — but a candidate who activates via the emailed
 * link lives ONLY in candidate_accounts. An identity is internal
 * (tenant_user_memberships) OR partner (partner_users) OR candidate
 * (candidate_accounts) in a given tenant, never mixed — exactly the rule
 * partner_users documents. Not expressible as a cross-table CHECK; enforced
 * at the application layer (candidateProcedure rejects internal/partner
 * identities by never finding a candidate_accounts row for them) plus the
 * periodic identity-audit query.
 *
 * person_id (compound FK → persons) is the load-bearing link: EVERY
 * candidate read is scoped to this person_id, so a candidate sees only their
 * own applications / interviews. Unique (tenant_id, person_id) means one
 * account per person; unique (tenant_id, user_id) means one account per auth
 * identity (partial — user_id is NULL while pending).
 *
 * Activation (no open self-signup):
 *   - status='pending', user_id NULL, activation_token_hash = SHA-256 of the
 *     signed link emailed to the person. Created by requestCandidateActivation.
 *   - The completion route locates the pending row BY that hash (mirrors how
 *     interviews.confirm_signed_link_token_hash locates an interview), creates
 *     the Supabase auth user, sets user_id + status='active' + activated_at,
 *     and NULLs the hash. Single-use is intrinsic: once consumed the hash is
 *     gone and status='active', so a replayed link finds no pending row.
 *
 * The FK from user_id to auth.users(id) lives in a future cross-schema
 * migration (same pattern as public.users.id and partner_users.user_id,
 * which ship as hand-written ALTERs outside Drizzle's schema graph).
 *
 * RLS: standard single tenant_isolation policy. FORCE + audit trigger
 * attached by the 0057/0058 companions (identity rows are audit-worthy —
 * same treatment as partner_users).
 */
export const candidateAccounts = pgTable(
  "candidate_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    // NULL until activation completes (the Supabase auth user is created then).
    userId: uuid("user_id"),
    status: text("status").notNull().default("pending"),
    // SHA-256 of the single-use activation signed link; NULL once consumed.
    activationTokenHash: text("activation_token_hash"),
    activationRequestedAt: timestamp("activation_requested_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_candidate_accounts_tenant_id_id").on(table.tenantId, table.id),
    // One account per person per tenant (pending or active).
    uniqueIndex("uniq_candidate_accounts_tenant_person").on(table.tenantId, table.personId),
    // One account per auth identity per tenant — partial, user_id is NULL
    // while pending.
    uniqueIndex("uniq_candidate_accounts_tenant_user")
      .on(table.tenantId, table.userId)
      .where(sql`user_id IS NOT NULL`),
    // Completion route looks the pending row up by hash.
    index("idx_candidate_accounts_activation_hash")
      .on(table.activationTokenHash)
      .where(sql`activation_token_hash IS NOT NULL`),
    check(
      "candidate_accounts_status_check",
      sql`${table.status} IN ('pending', 'active', 'disabled')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.personId],
      foreignColumns: [persons.tenantId, persons.id],
      name: "fk_candidate_accounts_person",
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

export type CandidateAccount = typeof candidateAccounts.$inferSelect;
export type NewCandidateAccount = typeof candidateAccounts.$inferInsert;
