import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * tenant_email_template_overrides — TENANT COPY OVERRIDES for the 12
 * transactional email templates (T1.4 / G09).
 *
 * WHY THIS TABLE EXISTS:
 * Every template in @hireops/email-templates ships code-owned copy — subjects
 * are string literals and bodies are React-email components. An org had NO way
 * to change any of the wording. This table is that config layer: one row per
 * (tenant, template_key) carrying an optional subject override and a
 * per-named-slot override map, so an admin can rebrand the copy WITHOUT a
 * deploy.
 *
 * THE HONESTY BOUNDARY (the G-class this fixes):
 * Only the SUBJECT and the template's NAMED TEXT SLOTS (see
 * EMAIL_TEMPLATE_CATALOG) are overridable. There is deliberately NO raw-HTML /
 * full-body column — that would open HTML injection and break the code-owned
 * DATA bindings (candidate name, position, dates, references, the .ics, links).
 * `slot_overrides` is a jsonb map of slotKey → override text; the API rejects
 * any slotKey (or token) the template does not declare. A row with `enabled`
 * false, or no row at all, renders BYTE-IDENTICALLY to the shipped template.
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companions in 0096/0097), exactly
 * like every other tenant-editable config table (market_benchmarks / t11
 * sources pattern) — an admin copy edit is audit-worthy.
 *
 * unique (tenant_id, template_key): one override row per template per tenant —
 * the upsert target for upsertEmailTemplateOverride and the seed's ON CONFLICT.
 */
export const tenantEmailTemplateOverrides = pgTable(
  "tenant_email_template_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // The @hireops/notifications TemplateKey this row overrides (text, not an
    // enum — the key set lives in TS, mirrored by the catalog + API validation).
    templateKey: text("template_key").notNull(),

    // Optional subject-line override (token-interpolated at render). NULL ⇒ the
    // code-owned default subject is used.
    subjectOverride: text("subject_override"),

    // slotKey → override text. Empty object ⇒ every slot falls back to its
    // shipped default. Validated against the template's catalog on write.
    slotOverrides: jsonb("slot_overrides")
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Whether this override is applied at send time. Disabled ⇒ default copy.
    enabled: boolean("enabled").notNull().default(true),

    // The admin who last wrote the row (nullable — service/seed writes have none).
    updatedBy: uuid("updated_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_tenant_email_template_overrides_tenant_id_id").on(table.tenantId, table.id),
    // One override row per template per tenant — the upsert / seed conflict target.
    unique("uniq_tenant_email_template_overrides_tenant_template").on(
      table.tenantId,
      table.templateKey,
    ),

    index("idx_tenant_email_template_overrides_tenant").on(table.tenantId),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TenantEmailTemplateOverride = typeof tenantEmailTemplateOverrides.$inferSelect;
export type NewTenantEmailTemplateOverride = typeof tenantEmailTemplateOverrides.$inferInsert;
