import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, boolean, pgPolicy } from "drizzle-orm/pg-core";

/**
 * Platform-level user profile. One row per real human, keyed by
 * auth.users.id.
 *
 * - The FK to auth.users(id) with ON DELETE CASCADE exists in the live DB
 *   (0004 migration) but isn't modelled here — Drizzle can't represent
 *   cross-schema FKs. The 0004 snapshot has it stripped to keep
 *   db:generate clean.
 * - User-scoped RLS: a user sees and updates only their own row. INSERT
 *   and DELETE for `authenticated` are intentionally absent — profile
 *   creation runs as service_role during signup, deletion cascades from
 *   auth.users.
 * - Tenant-specific attributes (job_title, manager, business_unit) live on
 *   tenant_user_memberships, not here.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().notNull(),

    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),

    locale: text("locale").notNull().default("en-IN"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),

    highContrast: boolean("high_contrast").notNull().default(false),
    reduceMotion: boolean("reduce_motion").notNull().default(false),

    emailDigestFrequency: text("email_digest_frequency").notNull().default("daily"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("users_self_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`id = auth.uid()`,
    }),
    pgPolicy("users_self_update", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
      using: sql`id = auth.uid()`,
      withCheck: sql`id = auth.uid()`,
    }),
    pgPolicy("users_auth_admin_read", {
      as: "permissive",
      for: "select",
      to: ["supabase_auth_admin"],
      using: sql`true`,
    }),
  ],
).enableRLS();

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
