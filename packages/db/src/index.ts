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
export type {
  StoreCredentialArgs,
  GetCredentialArgs,
  CredentialResult,
} from "./integration-credentials";
