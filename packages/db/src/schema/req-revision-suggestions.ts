import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  index,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * req_revision_suggestions — the cached, REAL-AI revision suggestions for a
 * REJECTED requisition (RO-01). Direct sibling of requisition_feasibility /
 * comp_recommendations: the AI produces advisory PROSE only (3–5 concrete
 * revision suggestions), grounded ONLY in the rejection reason, the req's own
 * fields, and curated market_benchmarks. Nothing auto-applies — the requirement
 * owner reviews the suggestions and resubmits through the normal REQ-02/03 edit
 * path.
 *
 * `suggestions` is the structured AI output jsonb (NOT NULL) — an array of
 * { area, title, detail } validated by the api-types reqRevisionAiSchema; kept
 * as jsonb so a prompt-shape evolution needs no migration. `rejection_reason`
 * snapshots the reason the suggestions were written against (provenance /
 * staleness). `model` + `prompt_version` stamp provenance.
 *
 * unique (tenant_id, requisition_id): ONE suggestion set per requisition —
 * regenerating REPLACES the row (ON CONFLICT upsert), never appends. Derived
 * cache, not an audit log, so replacement is correct.
 *
 * FKs: compound (tenant_id, requisition_id) → requisitions with CASCADE (derived
 * data must not outlive its requisition). generated_by_membership_id →
 * tenant_user_memberships with RESTRICT (the actor is a provenance leg that must
 * not be silently nulled). Tenant-scoped + FORCE RLS + audit trigger (companions
 * 0078/0079).
 */
export const reqRevisionSuggestions = pgTable(
  "req_revision_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    requisitionId: uuid("requisition_id").notNull(),

    suggestions: jsonb("suggestions").notNull(),
    rejectionReason: text("rejection_reason"),
    model: text("model"),
    promptVersion: text("prompt_version"),

    generatedByMembershipId: uuid("generated_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_req_revision_suggestions_tenant_id_id").on(table.tenantId, table.id),
    // ONE suggestion set per requisition — the upsert (regenerate-replaces) target.
    unique("uniq_req_revision_suggestions_per_req").on(table.tenantId, table.requisitionId),

    index("idx_req_revision_suggestions_req").on(table.tenantId, table.requisitionId),

    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_req_revision_suggestions_requisition",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.generatedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_req_revision_suggestions_generated_by",
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

export type ReqRevisionSuggestion = typeof reqRevisionSuggestions.$inferSelect;
export type NewReqRevisionSuggestion = typeof reqRevisionSuggestions.$inferInsert;
