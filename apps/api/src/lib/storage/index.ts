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
export type { StorageClient, StorageObject, StoragePutOpts } from "./types";
export { StorageError, StorageNotFoundError } from "./types";
