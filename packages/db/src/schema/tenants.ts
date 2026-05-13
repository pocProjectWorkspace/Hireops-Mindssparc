import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, pgPolicy } from "drizzle-orm/pg-core";

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(), // subdomain identifier; e.g., 'kyndryl-poc', 'acme'
    displayName: text("display_name").notNull(),
    primaryRegion: text("primary_region").notNull(), // 'ap-south-1' for Mumbai prod, 'ap-northeast-1' for Tokyo dev
    status: text("status").notNull(), // 'provisioning' | 'active' | 'suspended' | 'churned' | 'deleting'
    tier: text("tier").notNull().default("standard"), // 'standard' | 'sandbox' | 'dedicated' (future)
    onboardingStatus: text("onboarding_status").notNull().default("in_progress"), // 'in_progress' | 'completed'
    onboardingStepCompleted: text("onboarding_step_completed"), // 'identity' | 'integrations' | 'org_structure' | 'commercials' | etc.
    settings: jsonb("settings").notNull().default({}), // cosmetic config: logo URL, brand colour, locale defaults
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    scheduledDeletionAt: timestamp("scheduled_deletion_at", { withTimezone: true }), // DPDPA-aware soft-delete: 30-day grace
  },
  (table) => [
    index("idx_tenants_status").on(table.status),
    // Policies — mirror migration 0003_rls_baseline.sql so db:generate stays clean.
    pgPolicy("tenants_self_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`id = current_tenant_id()`,
    }),
    pgPolicy("tenants_auth_admin_read", {
      as: "permissive",
      for: "select",
      to: ["supabase_auth_admin"],
      using: sql`true`,
    }),
  ],
).enableRLS();

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
