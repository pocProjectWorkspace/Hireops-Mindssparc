import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  StorageError,
  StorageNotFoundError,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
} from "./types";

/**
 * Supabase Storage-backed client. Uses the service-role key so it can
 * write into a bucket whose policies don't grant anonymous insert
 * directly — which is the recommended posture (apply form hits the API,
 * the API holds the service-role key, the API writes to storage).
 *
 * The bucket itself must exist; see CONTRIBUTING.md for one-time
 * provisioning steps (Supabase Storage policies live outside Drizzle).
 */

export class SupabaseStorageClient implements StorageClient {
  readonly provider = "supabase" as const;
  readonly bucket: string;
  private readonly client: SupabaseClient;

  constructor(opts: { url: string; serviceRoleKey: string; bucket: string }) {
    if (!opts.url) throw new Error("SupabaseStorageClient: url required");
    if (!opts.serviceRoleKey) throw new Error("SupabaseStorageClient: serviceRoleKey required");
    this.bucket = opts.bucket;
    this.client = createClient(opts.url, opts.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async put(key: string, buffer: Buffer, opts: StoragePutOpts): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(key, buffer, {
      contentType: opts.contentType,
      cacheControl: opts.cacheControl ?? "3600",
      upsert: false,
    });
    if (error) throw new StorageError(`Supabase put failed: ${error.message}`, error);
  }

  async get(key: string): Promise<StorageObject> {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) {
      // Supabase returns "Object not found" message; classifying as
      // NotFound rather than a generic error keeps callers honest.
      if (error?.message?.toLowerCase().includes("not found")) {
        throw new StorageNotFoundError(key);
      }
      throw new StorageError(`Supabase get failed: ${error?.message ?? "unknown"}`, error);
    }
    const arrayBuffer = await data.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: data.type || "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) throw new StorageError(`Supabase delete failed: ${error.message}`, error);
  }
}
