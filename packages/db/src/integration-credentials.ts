import { and, eq } from "drizzle-orm";
import { db as poolDb } from "./client";
import { tenantEncryptionKeys } from "./schema/tenant-encryption-keys";
import { integrationCredentials } from "./schema/integration-credentials";
import { getKmsClient } from "./kms";
import { decryptStringWithDek, encryptWithDek, generateDek, unwrapDek, wrapDek } from "./envelope";
import { recordPiiAccess } from "./pii-access";

/**
 * High-level integration credential API.
 *
 * Both functions run as service_role via the unscoped pool — they must,
 * because tenant_encryption_keys is service-role-only (no RLS policies for
 * authenticated) and these helpers span tenant_encryption_keys +
 * integration_credentials.
 *
 * SECURITY: never call these from an HTTP handler with a user-supplied
 * tenantId. The tenantId argument is trusted. Validate it against the
 * request's authenticated tenant context before calling.
 */

export interface StoreCredentialArgs {
  tenantId: string;
  integrationType: string;
  secret: string;
  metadata: Record<string, unknown>;
}

export async function storeIntegrationCredential(args: StoreCredentialArgs): Promise<void> {
  const kms = getKmsClient();
  const dek = await getOrProvisionDek(args.tenantId, kms);
  const envelope = encryptWithDek(args.secret, dek);

  await poolDb
    .insert(integrationCredentials)
    .values({
      tenantId: args.tenantId,
      integrationType: args.integrationType,
      credentialEnvelope: Buffer.from(envelope),
      metadata: args.metadata,
    })
    .onConflictDoUpdate({
      target: [integrationCredentials.tenantId, integrationCredentials.integrationType],
      set: {
        credentialEnvelope: Buffer.from(envelope),
        metadata: args.metadata,
        updatedAt: new Date(),
      },
    });
}

export interface GetCredentialArgs {
  tenantId: string;
  integrationType: string;
}

/**
 * Optional accountability context for a credential read (ADR-002 §7). Existing
 * callers that don't pass it still compile; when absent the read is recorded
 * with actor_label 'service_role' and reason 'unspecified' — the ADR wants
 * every credential read logged, so absence of context must not mean absence of
 * a row.
 */
export interface CredentialAccessContext {
  actorLabel: string;
  reason: string;
  requestId?: string;
}

export interface CredentialResult {
  secret: string;
  metadata: Record<string, unknown>;
}

export async function getIntegrationCredential(
  args: GetCredentialArgs,
  accessContext?: CredentialAccessContext,
): Promise<CredentialResult | null> {
  const kms = getKmsClient();

  const [credRow] = await poolDb
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.tenantId, args.tenantId),
        eq(integrationCredentials.integrationType, args.integrationType),
      ),
    )
    .limit(1);

  if (!credRow) return null;

  // ADR-002 §7 — record the decrypted-credential read (fire-and-forget).
  // Service-role path: no human actor, so ids stay null and the label
  // describes the caller (or defaults to 'service_role').
  recordPiiAccess({
    tenantId: args.tenantId,
    actorLabel: accessContext?.actorLabel ?? "service_role",
    entityType: "integration_credential",
    entityId: credRow.id,
    fieldsAccessed: ["credential_envelope"],
    reason: accessContext?.reason ?? "unspecified",
    requestId: accessContext?.requestId ?? null,
  });

  const [dekRow] = await poolDb
    .select()
    .from(tenantEncryptionKeys)
    .where(eq(tenantEncryptionKeys.tenantId, args.tenantId))
    .limit(1);
  if (!dekRow) {
    throw new Error(
      `Tenant ${args.tenantId} has integration_credentials but no tenant_encryption_keys row`,
    );
  }

  const dek = await unwrapDek(dekRow.encryptedDek, dekRow.kmsKeyId, kms);
  const secret = decryptStringWithDek(credRow.credentialEnvelope, dek);

  return {
    secret,
    metadata: credRow.metadata as Record<string, unknown>,
  };
}

/**
 * Returns the tenant's DEK (unwrapped), provisioning a fresh DEK + row if
 * none exists. Bypasses RLS via the unscoped pool because
 * tenant_encryption_keys has no authenticated-role policies.
 */
async function getOrProvisionDek(
  tenantId: string,
  kms: ReturnType<typeof getKmsClient>,
): Promise<Uint8Array> {
  const existing = await poolDb
    .select()
    .from(tenantEncryptionKeys)
    .where(eq(tenantEncryptionKeys.tenantId, tenantId))
    .limit(1);

  const row = existing[0];
  if (!row) {
    const dek = generateDek();
    const wrapped = await wrapDek(dek, kms);
    await poolDb.insert(tenantEncryptionKeys).values({
      tenantId,
      encryptedDek: Buffer.from(wrapped.encryptedDek),
      kmsKeyId: wrapped.kmsKeyId,
    });
    return dek;
  }

  return unwrapDek(row.encryptedDek, row.kmsKeyId, kms);
}
