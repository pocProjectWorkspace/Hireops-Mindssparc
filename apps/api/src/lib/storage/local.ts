import {
  StorageNotFoundError,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
} from "./types";

/**
 * In-process Map-backed Storage. Used in tests + when STORAGE_PROVIDER is
 * unset locally. Survives a single Node process; not durable.
 *
 * Reset between tests via resetLocalStorage() — vitest fork-pool isolates
 * files, but within a file we want a clean slate before each test that
 * touches storage.
 */

let store = new Map<string, StorageObject>();

export class LocalStorageClient implements StorageClient {
  readonly provider = "local" as const;
  readonly bucket: string;

  constructor(opts: { bucket: string }) {
    this.bucket = opts.bucket;
  }

  async put(key: string, buffer: Buffer, opts: StoragePutOpts): Promise<void> {
    store.set(this.scope(key), { buffer, contentType: opts.contentType });
  }

  async get(key: string): Promise<StorageObject> {
    const got = store.get(this.scope(key));
    if (!got) throw new StorageNotFoundError(key);
    return got;
  }

  async delete(key: string): Promise<void> {
    store.delete(this.scope(key));
  }

  private scope(key: string): string {
    return `${this.bucket}:${key}`;
  }
}

export function resetLocalStorage(): void {
  store = new Map();
}
