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
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * recruiter_brief — cached, REAL-AI recruiter-brief aids for one application
 * (RECR-03). Same honest pattern as interview_prep (0074): a grounded prompt
 * (JD + skills, deterministic skills-match, parsed resume, application data) is
 * sent to Claude via @hireops/ai-client's completeStructured (cost-logged to
 * ai_usage_logs), and the structured result is cached here so the brief renders
 * instantly. ONE row per (application, kind); regenerate REPLACES (ON CONFLICT
 * upsert), never appends — a derived cache, not an audit log.
 *
 * `kind` is one of strengths_risks | screen_script | availability_draft.
 * `content` is the kind-specific jsonb (validated by the api-types zod schema);
 * kept jsonb so a prompt-shape evolution needs no migration. `model` +
 * `prompt_version` stamp provenance. The availability_draft is a DRAFT only —
 * caching it never sends it.
 *
 * FKs: compound (tenant_id, application_id) → applications CASCADE;
 * (tenant_id, generated_by_membership_id) → memberships RESTRICT (provenance).
 * Tenant-scoped + FORCE RLS + audit trigger (companion migration 0087).
 */
export const recruiterBrief = pgTable(
  "recruiter_brief",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    applicationId: uuid("application_id").notNull(),
    kind: text("kind").notNull(),

    content: jsonb("content").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),

    generatedByMembershipId: uuid("generated_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_recruiter_brief_tenant_id_id").on(table.tenantId, table.id),
    // ONE brief per (application, kind) — the upsert (regenerate-replaces) target.
    unique("uniq_recruiter_brief_per_app_kind").on(table.tenantId, table.applicationId, table.kind),

    index("idx_recruiter_brief_app").on(table.tenantId, table.applicationId),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_recruiter_brief_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.generatedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_recruiter_brief_generated_by",
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

export type RecruiterBrief = typeof recruiterBrief.$inferSelect;
export type NewRecruiterBrief = typeof recruiterBrief.$inferInsert;
