import { LocalStorageClient, resetLocalStorage } from "./local";
import { SupabaseStorageClient } from "./supabase";
import type { StorageClient } from "./types";

/**
 * Factory + module-level cache (per-process singleton). Same shape as
 * getSentryClient: first call resolves the env, subsequent calls return
 * the cached client. resetStorageClient() is the test escape hatch.
 *
 * Selection:
 *   - NODE_ENV=test           → LocalStorageClient (no Supabase needed in CI)
 *   - STORAGE_PROVIDER=local  → LocalStorageClient (dev convenience)
 *   - default                 → SupabaseStorageClient (requires SUPABASE_URL
 *                               + SUPABASE_SERVICE_ROLE_KEY)
 */

const DEFAULT_BUCKET = "candidate-uploads";

let cached: StorageClient | undefined;

export function getStorageClient(): StorageClient {
  if (cached) return cached;
  const bucket = process.env.STORAGE_BUCKET ?? DEFAULT_BUCKET;
  if (process.env.NODE_ENV === "test" || process.env.STORAGE_PROVIDER === "local") {
    cached = new LocalStorageClient({ bucket });
    return cached;
  }
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SupabaseStorageClient requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. " +
        "Set STORAGE_PROVIDER=local for dev without Supabase.",
    );
  }
  cached = new SupabaseStorageClient({ url, serviceRoleKey, bucket });
  return cached;
}

export function resetStorageClient(): void {
  cached = undefined;
  resetLocalStorage();
}

export { LocalStorageClient, SupabaseStorageClient };
// Round-trip helpers for the local tier's fake signed URLs (N3.2). They
// live on the barrel so tests and STORAGE_PROVIDER=local dev code can
// dereference a minted URL without importing the tier directly.
export { parseLocalSignedUrl, resolveLocalSignedUrl, writeLocalSignedUploadUrl } from "./local";
export { SUPABASE_SIGNED_UPLOAD_TTL_SECONDS } from "./supabase";
export type {
  SignedUploadUrl,
  SignedUploadUrlOpts,
  SignedUrl,
  SignedUrlOpts,
  StorageClient,
  StorageObject,
  StorageObjectStat,
  StoragePutOpts,
} from "./types";
export {
  clampSignedUrlTtlSeconds,
  SIGNED_URL_DEFAULT_TTL_SECONDS,
  SIGNED_URL_MAX_TTL_SECONDS,
  StorageError,
  StorageNotFoundError,
} from "./types";
