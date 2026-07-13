/**
 * Store the demo tenant's Anthropic API key as an ai_anthropic
 * integration credential (envelope-encrypted per ADR-002).
 *
 * Reads ANTHROPIC_DEMO_API_KEY from the repo .env — the key never
 * appears on the command line or in logs. Idempotent: re-running
 * overwrites the stored credential (storeIntegrationCredential
 * upserts on (tenant_id, integration_type)).
 *
 * Run with: pnpm db:store:demo-ai-credential
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TARGET_TENANT_SLUG = "kyndryl-poc";

async function main(): Promise<void> {
  // Dynamic imports so dotenv loads first (client.ts reads DATABASE_URL
  // at module init; KMS reads SUPABASE_KEK_SECRET).
  const { eq } = await import("drizzle-orm");
  const { db, sql: poolSql } = await import("../client");
  const { tenants } = await import("../schema/tenants");
  const { storeIntegrationCredential } = await import("../integration-credentials");

  try {
    const apiKey = process.env.ANTHROPIC_DEMO_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      throw new Error(
        "ANTHROPIC_DEMO_API_KEY is not set in .env (or is not an sk-ant-… key).",
      );
    }

    const [tenant] = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, TARGET_TENANT_SLUG));
    if (!tenant) throw new Error(`Tenant '${TARGET_TENANT_SLUG}' not found.`);

    await storeIntegrationCredential({
      tenantId: tenant.id,
      integrationType: "ai_anthropic",
      secret: apiKey,
      metadata: { provisioned_by: "store-demo-ai-credential", purpose: "demo" },
    });

    console.log(
      `ai_anthropic credential stored for tenant '${tenant.slug}' (${tenant.id}). ` +
        "AI scoring and agent drafts now use the real provider for this tenant.",
    );
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
