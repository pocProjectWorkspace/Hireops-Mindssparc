import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  char,
  jsonb,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * market_benchmarks — HR-head "Market Intelligence" reference data (HRHEAD-02).
 *
 * HONEST-BENCHMARK MODELLING (read this — it is the whole point of the table):
 * the prototype's Market Intelligence table FAKES its numbers. We do NOT. This
 * table holds CURATED, tenant-editable reference rows — one per role title —
 * that an admin maintains by hand and that the UI labels as such via
 * `source_note` (e.g. "Curated benchmark — update quarterly"). There is no
 * live market-data feed behind it and the surface never pretends there is. A
 * real external market-data integration is explicitly out of scope; when one
 * lands it populates these same rows and stamps a different source_note.
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companions 0063/0064) exactly like
 * every other tenant-editable domain table — an admin edit is audit-worthy.
 *
 * Money: `median_salary_minor` is bigint in MINOR currency units (paise for
 * INR), matching offers.base_salary_inr_paise / final_settlements.amount_minor —
 * NOT the positions.comp_band_* convention, which stores MAJOR units (numeric
 * rupees). The feasibility builder converts minor→major when it compares a
 * benchmark median against a position's comp band. `currency` is char(3),
 * default 'INR' (the demo tenant is INR-only).
 *
 * `availability` / `competitor_demand` are text + CHECK (low|medium|high), the
 * HANDOVER reality #114 discipline (an enum column compared against invalid
 * text THROWS in Postgres; text + CHECK compares cleanly and grows with a
 * one-line additive ALTER). `trending_skills` is a jsonb string array
 * (default '[]') rendered as the per-role trending-skills cards.
 *
 * unique (tenant_id, role_title): one benchmark per role per tenant — the
 * upsert target for upsertMarketBenchmark and the seed's ON CONFLICT. Fuzzy
 * title matching to a requisition happens in application code (the feasibility
 * builder), not here — the DB key is the exact title.
 */
export const marketBenchmarks = pgTable(
  "market_benchmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    roleTitle: text("role_title").notNull(),

    // Median in MINOR units (paise) — matches offers/settlements, NOT positions.
    medianSalaryMinor: bigint("median_salary_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("INR"),

    ttfDays: integer("ttf_days").notNull(),
    availability: text("availability").notNull(),
    competitorDemand: text("competitor_demand").notNull(),
    recommendedRounds: integer("recommended_rounds").notNull(),

    trendingSkills: jsonb("trending_skills")
      .notNull()
      .default(sql`'[]'::jsonb`),

    // The honesty field — surfaced verbatim in the UI so no one mistakes a
    // curated reference row for a live market feed.
    sourceNote: text("source_note").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_market_benchmarks_tenant_id_id").on(table.tenantId, table.id),
    // One benchmark per role per tenant — the upsert / seed conflict target.
    unique("uniq_market_benchmarks_tenant_role").on(table.tenantId, table.roleTitle),

    index("idx_market_benchmarks_tenant").on(table.tenantId),

    check(
      "market_benchmarks_availability_check",
      sql`${table.availability} IN ('low', 'medium', 'high')`,
    ),
    check(
      "market_benchmarks_competitor_demand_check",
      sql`${table.competitorDemand} IN ('low', 'medium', 'high')`,
    ),
    check("market_benchmarks_median_check", sql`${table.medianSalaryMinor} >= 0`),
    check("market_benchmarks_ttf_check", sql`${table.ttfDays} >= 0`),
    check("market_benchmarks_rounds_check", sql`${table.recommendedRounds} >= 0`),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type MarketBenchmark = typeof marketBenchmarks.$inferSelect;
export type NewMarketBenchmark = typeof marketBenchmarks.$inferInsert;
