export * from "./client";
export * from "./schema";
export { withTenantContext, drizzleSql } from "./with-tenant-context";
export type {
  JwtClaims,
  TenantContext,
  TenantBoundDb,
  TenantContextMetadata,
  TenantContextSource,
} from "./with-tenant-context";

// Envelope encryption + KMS (FND-15d).
export * from "./kms";
export {
  generateDek,
  wrapDek,
  unwrapDek,
  encryptWithDek,
  decryptWithDek,
  decryptStringWithDek,
} from "./envelope";
export { storeIntegrationCredential, getIntegrationCredential } from "./integration-credentials";
export { recordPiiAccess } from "./pii-access";
export type { RecordPiiAccessArgs } from "./pii-access";
export type {
  StoreCredentialArgs,
  GetCredentialArgs,
  CredentialResult,
  CredentialAccessContext,
} from "./integration-credentials";

// Agent config zod schemas (AGENT-01a).
export * from "./zod/agent-configs";
