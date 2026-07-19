import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  unique,
  index,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * comp_recommendations — the cached, REAL-AI compensation RATIONALE for one
 * application (HROPS-02). Direct sibling of requisition_feasibility: the AI
 * writes PROSE only; the deterministic comp verdict (proceed | negotiate |
 * need_approval) is always rule-computed at read time and is authoritative.
 * We snapshot the verdict + suggested number the rationale was written against
 * (`verdict`, `suggested_inr_paise`) purely for provenance / staleness display
 * — if the band or expected salary changes after generation, the desk recomputes
 * the live verdict and can show "rationale may be stale".
 *
 * `rationale` is the short narrative (NOT NULL). `model` + `prompt_version`
 * stamp provenance across a regenerated corpus.
 *
 * unique (tenant_id, application_id): ONE rationale per application —
 * regenerating REPLACES the row (ON CONFLICT upsert), never appends. Derived
 * cache, not an audit log, so replacement is correct.
 *
 * FKs: compound (tenant_id, application_id) → applications with CASCADE (derived
 * data must not outlive its application). generated_by_membership_id →
 * tenant_user_memberships with RESTRICT (the actor is a provenance leg that must
 * not be silently nulled). Tenant-scoped + FORCE RLS + audit trigger
 * (companions in the HROPS-02 migration trio).
 */
export const compRecommendations = pgTable(
  "comp_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    applicationId: uuid("application_id").notNull(),

    rationale: text("rationale").notNull(),
    // Snapshot of the deterministic verdict the prose was written against.
    verdict: text("verdict").notNull(),
    suggestedInrPaise: bigint("suggested_inr_paise", { mode: "bigint" }).notNull(),

    model: text("model"),
    promptVersion: text("prompt_version"),

    generatedByMembershipId: uuid("generated_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_comp_recommendations_tenant_id_id").on(table.tenantId, table.id),
    // ONE rationale per application — the upsert (regenerate-replaces) target.
    unique("uniq_comp_recommendations_per_application").on(table.tenantId, table.applicationId),

    index("idx_comp_recommendations_application").on(table.tenantId, table.applicationId),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_comp_recommendations_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.generatedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_comp_recommendations_generated_by",
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

export type CompRecommendation = typeof compRecommendations.$inferSelect;
export type NewCompRecommendation = typeof compRecommendations.$inferInsert;
