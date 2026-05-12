import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * Platform-level user profile. One row per real human, keyed by
 * auth.users.id.
 *
 * - FK to auth.users.id with ON DELETE CASCADE is added in
 *   0005_db01_handwritten.sql; Drizzle can't model cross-schema FKs.
 * - User-scoped RLS: a user sees and updates only their own row.
 *   Policies are also in 0005.
 * - Survives tenant offboarding. A user remains a user even with no
 *   active memberships.
 *
 * Tenant-specific attributes (job_title, manager, business_unit) live on
 * tenant_user_memberships, not here.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().notNull(),

  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),

  locale: text("locale").notNull().default("en-IN"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),

  highContrast: boolean("high_contrast").notNull().default(false),
  reduceMotion: boolean("reduce_motion").notNull().default(false),

  // Default 'daily'. Enum-ify when the notification system is built.
  emailDigestFrequency: text("email_digest_frequency").notNull().default("daily"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
