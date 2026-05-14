import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  customType,
  uniqueIndex,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Per-tenant encrypted credentials for outbound integrations
 * (architecture.md §5.1).
 *
 * credential_envelope is the iv || authTag || ciphertext payload produced
 * by encryptWithDek(secret, tenantDek). metadata holds non-secret config
 * (URLs, client IDs, scopes) and can be projected to admins safely.
 *
 * RLS: admins in the tenant can SELECT (intended for the credential
 * management UI — but app code MUST project metadata only, never
 * credential_envelope, when responding to authenticated requests).
 * No INSERT/UPDATE/DELETE policies → only service_role can mutate. That's
 * the storeIntegrationCredential / getIntegrationCredential pathway,
 * which encrypts/decrypts in-process and never exposes the envelope or
 * DEK to authenticated callers.
 *
 * integration_type is text + CHECK rather than a pgEnum because the list
 * is long and growing (workday, bgv, idp_oidc, idp_saml, esign_docusign,
 * esign_adobe, calendar_google, calendar_outlook, video_zoom, video_teams,
 * jobboard_linkedin, jobboard_naukri, jobboard_indeed, …). Easier to
 * extend the CHECK than to ALTER TYPE.
 */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    integrationType: text("integration_type").notNull(),
    credentialEnvelope: bytea("credential_envelope").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_integration_credentials_tenant_type").on(
      table.tenantId,
      table.integrationType,
    ),
    unique("uniq_integration_credentials_tenant_id_id").on(table.tenantId, table.id),
    check(
      "integration_credentials_type_check",
      sql`${table.integrationType} IN (
        'workday',
        'bgv',
        'idp_oidc',
        'idp_saml',
        'esign_docusign',
        'esign_adobe',
        'calendar_google',
        'calendar_outlook',
        'video_zoom',
        'video_teams',
        'jobboard_linkedin',
        'jobboard_naukri',
        'jobboard_indeed'
      )`,
    ),
    // Admin-only SELECT. App layer MUST project metadata only (not
    // credential_envelope) when serving authenticated requests — column-
    // level grants don't compose with RLS cleanly under FORCE so the
    // column filter is app-enforced.
    pgPolicy("tenant_isolation_admin_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id() AND has_role('admin')`,
    }),
    // No INSERT/UPDATE/DELETE policies → service_role only. The
    // storeIntegrationCredential helper runs through the unscoped pool.
  ],
).enableRLS();

export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type NewIntegrationCredential = typeof integrationCredentials.$inferInsert;
