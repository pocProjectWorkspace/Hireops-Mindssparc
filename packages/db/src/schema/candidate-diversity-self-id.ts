import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  uniqueIndex,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { persons } from "./persons";

/**
 * candidate_diversity_self_id — VOLUNTARY diversity self-identification
 * (PC-26, migration 0126). The only demographic data the platform holds.
 *
 * Deliberately SEPARATE from persons / candidates / applications so no
 * existing select, list, detail, export, scoring or AI read can pick it up by
 * accident: a column on those tables would ride along in every `select *`.
 *
 * Shape:
 *   - one row per (person, category) answer; "prefer not to say" is NEVER a
 *     row — choosing it, or withdrawing, sets `withdrawn_at` on the active
 *     row. A partial unique keeps at most one ACTIVE answer per category.
 *   - `disclosure_version` = the exact disclosure copy the candidate saw.
 *   - `collected_via` is CHECKed to the two candidate-owned seams
 *     ('apply_form', 'candidate_portal'). There is no partner or recruiter
 *     value: staff cannot record a candidate's demographics.
 *
 * Access:
 *   - RLS: FORCE + a single `tenant_isolation_candidate_self` policy that
 *     also requires has_role('candidate'). A staff JWT (recruiter / admin /
 *     partner) therefore sees ZERO rows through the RLS client. The aggregate
 *     slate count runs through the service-role pool inside
 *     apps/api/src/lib/diversity-slate.ts and returns numbers only; the
 *     candidate reads their own rows with an explicit person_id predicate.
 *   - Audit: a REDACTING variant of the audit trigger (the `value` column is
 *     written to audit_logs as "[redacted]"), so the audit trail records
 *     that an answer was given / withdrawn without copying it.
 *
 * FK (tenant_id, person_id) → persons CASCADE: erasing a person erases their
 * answers.
 */
export const candidateDiversitySelfId = pgTable(
  "candidate_diversity_self_id",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    /** Tenant-configured category key, e.g. 'gender'. */
    categoryKey: text("category_key").notNull(),
    /** Tenant-configured option value, e.g. 'woman'. Never 'prefer_not_to_say'. */
    value: text("value").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    /** 'apply_form' | 'candidate_portal' — candidate-owned seams only. */
    collectedVia: text("collected_via").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (table) => [
    unique("uniq_candidate_diversity_self_id_tenant_id_id").on(table.tenantId, table.id),
    uniqueIndex("uniq_candidate_diversity_self_id_active")
      .on(table.tenantId, table.personId, table.categoryKey)
      .where(sql`withdrawn_at IS NULL`),
    index("idx_candidate_diversity_self_id_person").on(table.tenantId, table.personId),
    check(
      "candidate_diversity_self_id_collected_via_check",
      sql`${table.collectedVia} IN ('apply_form', 'candidate_portal')`,
    ),
    check(
      "candidate_diversity_self_id_key_check",
      sql`${table.categoryKey} ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check(
      "candidate_diversity_self_id_value_check",
      sql`${table.value} ~ '^[a-z][a-z0-9_]{0,39}$' AND ${table.value} <> 'prefer_not_to_say'`,
    ),
    foreignKey({
      columns: [table.tenantId, table.personId],
      foreignColumns: [persons.tenantId, persons.id],
      name: "fk_candidate_diversity_self_id_person",
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation_candidate_self", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id() AND has_role('candidate')`,
      withCheck: sql`tenant_id = current_tenant_id() AND has_role('candidate')`,
    }),
  ],
).enableRLS();

export type CandidateDiversitySelfId = typeof candidateDiversitySelfId.$inferSelect;
