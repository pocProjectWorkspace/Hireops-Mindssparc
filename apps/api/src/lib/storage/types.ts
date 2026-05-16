/**
 * Pluggable object-storage interface. Same three-tier pattern as
 * @hireops/db's KMS client and @hireops/ai-client's AIClient:
 *   - SupabaseStorageClient — production, wraps @supabase/supabase-js
 *   - LocalStorageClient    — in-memory, used in tests and dev
 *   - getStorageClient()    — factory dispatched by STORAGE_PROVIDER env
 *
 * The interface is intentionally small. Resume-style uploads are the
 * only consumer today; richer features (signed URLs, lifecycle policies)
 * land when a feature needs them.
 */

export interface StoragePutOpts {
  contentType: string;
  cacheControl?: string;
}

export interface StorageObject {
  buffer: Buffer;
  contentType: string;
}

export interface StorageClient {
  readonly provider: "supabase" | "local";
  readonly bucket: string;

  /**
   * Stores buffer at key. Throws on transport failure. Idempotent at the
   * application layer — callers compose key from a UUID so collisions are
   * effectively impossible.
   */
  put(key: string, buffer: Buffer, opts: StoragePutOpts): Promise<void>;

  /**
   * Returns the stored object. Throws StorageNotFoundError if absent —
   * callers should treat this as a 404 condition, not a 500.
   */
  get(key: string): Promise<StorageObject>;

  /**
   * Deletes the object at key. No-op if absent. Used by cleanup paths
   * (e.g. submitApplication rollback on parse failure if we add that).
   */
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly underlying?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
