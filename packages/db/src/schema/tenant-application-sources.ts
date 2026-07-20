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
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applicationSourceEnum } from "./application-source";

/**
 * tenant_application_sources — the SOURCING-CHANNEL REGISTRY (G04).
 *
 * WHY THIS TABLE EXISTS (read this — it is the whole point):
 * `application_source` is a FIXED pgEnum — the canonical, platform-wide
 * sourcing taxonomy (career_site, referral, job_board, …). It is NOT
 * tenant config: every tenant shares the same eight values and an org has
 * no way to say WHICH channels it actually uses, what to CALL them, or to
 * turn one off. This registry is that config LAYER over the enum. One row
 * per (tenant, source_enum) declares: is this channel enabled for the org
 * (`enabled`), what does the org call it (`label`), a free-text `notes`
 * blurb, and an optional per-source `config` blob (a career-site slug, a
 * mailbox address string, …). The enum stays the canonical key; the
 * registry is the tenant's editable view of it.
 *
 * HONESTY — ingestion vs configuration (`ingestion_mode`):
 * declaring a channel here CONFIGURES it; it does NOT connect an automated
 * pull. Candidates arrive today only via the existing manual/portal paths
 * (the public career-site apply form, partner submissions, recruiter-entered
 * attribution). `ingestion_mode` records that honestly:
 *   - 'manual'            — candidates enter via existing portal/manual flows.
 *   - 'connector_pending' — an automated pull (mailbox / job-board / LinkedIn
 *                           connector) is a deferred IMPLEMENTATION work
 *                           package; the channel is configured, not live.
 * The admin surface labels a connector_pending channel "channel configured —
 * ingestion is a connector work package". The registry never pretends a
 * channel auto-pulls candidates.
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companions in 0091/0092), exactly
 * like every other tenant-editable config table (market_benchmarks pattern) —
 * an admin edit here is audit-worthy.
 *
 * unique (tenant_id, source_enum): one registry row per channel per tenant —
 * the upsert target for upsertTenantSource and the seed's ON CONFLICT.
 */
export const tenantApplicationSources = pgTable(
  "tenant_application_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // The canonical taxonomy value this registry row configures. The enum is
    // the platform key; this table is the tenant's config over it.
    sourceEnum: applicationSourceEnum("source_enum").notNull(),

    // The org's display label for the channel (what recruiters see).
    label: text("label").notNull(),

    // Whether this channel is turned on for the tenant's pipeline.
    enabled: boolean("enabled").notNull().default(true),

    // Honesty flag — see the header. 'manual' | 'connector_pending'.
    ingestionMode: text("ingestion_mode").notNull().default("manual"),

    // Optional per-source config (career-site slug, mailbox address string,
    // job-board name, …). A placeholder blob — no connector consumes it yet.
    config: jsonb("config")
      .notNull()
      .default(sql`'{}'::jsonb`),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_tenant_application_sources_tenant_id_id").on(table.tenantId, table.id),
    // One registry row per channel per tenant — the upsert / seed conflict target.
    unique("uniq_tenant_application_sources_tenant_source").on(table.tenantId, table.sourceEnum),

    index("idx_tenant_application_sources_tenant").on(table.tenantId),

    check(
      "tenant_application_sources_ingestion_mode_check",
      sql`${table.ingestionMode} IN ('manual', 'connector_pending')`,
    ),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TenantApplicationSource = typeof tenantApplicationSources.$inferSelect;
export type NewTenantApplicationSource = typeof tenantApplicationSources.$inferInsert;
