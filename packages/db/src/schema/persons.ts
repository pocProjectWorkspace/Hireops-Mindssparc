import { sql } from "drizzle-orm";
import { pgTable, uuid, text, char, timestamp, index, unique, pgPolicy } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Canonical identity. Tenant-scoped. Redaction-friendly.
 *
 * Every PII column is nullable. A redacted person has every PII column
 * nulled (set redacted_at + redaction_reason); the row stays for FK
 * integrity so audit history, application records, and partner ownership
 * claims continue to resolve.
 *
 * Dedup pivot:
 *   email_normalised and phone_normalised are app-maintained companion
 *   columns. The intent is:
 *     - email_normalised: lowercase, drop +suffixes, and for @gmail.com
 *       addresses strip dots from the local part (gmail treats them as
 *       equivalent). Anything else: lowercase + drop +suffixes.
 *     - phone_normalised: digits-only with country code (no spaces, dashes,
 *       parentheses, leading + or 00).
 *   These rules are not enforced at the DB. The columns are nullable text;
 *   the parser / intake form / partner import code is responsible for
 *   computing them consistently. If they are not populated, dedup against
 *   this table will be best-effort (raw email/phone match only) and
 *   gmail-dot variants will create duplicate persons. A future ticket can
 *   move the rule into a generated column once the rule itself is stable
 *   across all sourcing channels.
 *
 * RLS: standard tenant_isolation policy. Trigger: audit_record_change()
 * fires on INSERT/UPDATE/DELETE (see migrations 0014/0015).
 */
export const persons = pgTable(
  "persons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fullName: text("full_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    emailPrimary: text("email_primary"),
    emailNormalised: text("email_normalised"),
    phonePrimary: text("phone_primary"),
    phoneNormalised: text("phone_normalised"),
    locationCountry: char("location_country", { length: 2 }),
    locationCity: text("location_city"),
    linkedinUrl: text("linkedin_url"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    redactionReason: text("redaction_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_persons_tenant_id_id").on(table.tenantId, table.id),
    // Dedup lookup paths — partial indexes skip NULL pivots.
    index("idx_persons_email_normalised")
      .on(table.tenantId, table.emailNormalised)
      .where(sql`email_normalised IS NOT NULL`),
    index("idx_persons_phone_normalised")
      .on(table.tenantId, table.phoneNormalised)
      .where(sql`phone_normalised IS NOT NULL`),
    // Retention sweep: surface candidates for the redaction job.
    index("idx_persons_redaction_sweep")
      .on(table.tenantId, table.redactedAt)
      .where(sql`redacted_at IS NULL`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type Person = typeof persons.$inferSelect;
export type NewPerson = typeof persons.$inferInsert;
