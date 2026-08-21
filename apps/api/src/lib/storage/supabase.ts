import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  clampSignedUrlTtlSeconds,
  StorageError,
  StorageNotFoundError,
  type SignedUploadUrl,
  type SignedUploadUrlOpts,
  type SignedUrl,
  type SignedUrlOpts,
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

  /**
   * createSignedUrl takes the TTL in seconds, so our policy maps onto the
   * vendor exactly: whatever clampSignedUrlTtlSeconds() returns is what the
   * token's `exp` claim carries. Errors are classified the same way get()
   * does — a missing object is a 404 condition, not a 500.
   */
  async createSignedReadUrl(key: string, opts?: SignedUrlOpts): Promise<SignedUrl> {
    const ttlSeconds = clampSignedUrlTtlSeconds(opts?.ttlSeconds);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, ttlSeconds);
    if (error || !data?.signedUrl) {
      if (error?.message?.toLowerCase().includes("not found")) {
        throw new StorageNotFoundError(key);
      }
      throw new StorageError(
        `Supabase createSignedUrl failed: ${error?.message ?? "unknown"}`,
        error,
      );
    }
    return {
      url: data.signedUrl,
      key,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      ttlSeconds,
      provider: "supabase",
    };
  }

  /**
   * THE VENDOR OWNS THE TTL ON THIS ONE. `createSignedUploadUrl(path,
   * { upsert })` takes no expiry argument — Supabase Storage fixes signed
   * upload tokens at two hours, which is above our 60-minute ceiling and
   * not something the client can negotiate. Options considered:
   *
   *   - Pretend: return `now + requested ttl`. Rejected. The URL would keep
   *     working after the expiry we advertised, and the first person to
   *     rely on `expiresAt` as a security property would be wrong.
   *   - Sign our own upload URL. Not possible with the service-role key
   *     alone; it would mean reimplementing Supabase's token format.
   *   - Report the truth. Chosen.
   *
   * So `ttlSeconds`/`expiresAt` here describe what Supabase actually
   * granted, not what was asked for, and `opts.ttlSeconds` is accepted (for
   * interface symmetry and for the local tier, which does honour it) but
   * has no effect on the real tier. The window is bounded in practice by
   * how the URL is used rather than by its own expiry: the API mints one
   * per recording, hands it to one browser, and the recording row it
   * belongs to is created up front — a replayed URL can only overwrite
   * the object the API already expected to receive, and only when
   * upsert was requested.
   *
   * The exact expiry is read off the token's `exp` claim where we can parse
   * one, so this stays honest if the vendor changes the window.
   */
  async createSignedUploadUrl(key: string, opts?: SignedUploadUrlOpts): Promise<SignedUploadUrl> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(key, { upsert: opts?.upsert ?? false });
    if (error || !data?.signedUrl) {
      // "The resource already exists" when upsert is false and the key is
      // taken; everything else is transport/permission failure. Neither is
      // a not-found condition, so both are plain StorageErrors.
      throw new StorageError(
        `Supabase createSignedUploadUrl failed: ${error?.message ?? "unknown"}`,
        error,
      );
    }
    const expiresAt = signedUploadExpiry(data.token);
    return {
      url: data.signedUrl,
      key,
      expiresAt,
      ttlSeconds: Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)),
      provider: "supabase",
      method: "PUT",
      token: data.token,
    };
  }
}

/**
 * Supabase's documented lifetime for a signed upload token. Used as the
 * fallback when the token is not a JWT we can read an `exp` out of — better
 * a documented constant than a number we invented.
 */
export const SUPABASE_SIGNED_UPLOAD_TTL_SECONDS = 2 * 60 * 60;

/**
 * Best-effort `exp` extraction. The token is a JWT, but we deliberately do
 * NOT verify it (we have no reason to — we just received it over TLS from
 * the service that signed it) and we do not add a JWT dependency for one
 * base64 decode. Any surprise in the shape falls back to the documented
 * two hours rather than throwing: failing an upload because we could not
 * pretty-print its expiry would be absurd.
 */
function signedUploadExpiry(token: string | undefined): Date {
  const fallback = new Date(Date.now() + SUPABASE_SIGNED_UPLOAD_TTL_SECONDS * 1000);
  const payload = token?.split(".")[1];
  if (!payload) return fallback;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = (decoded as { exp?: unknown } | null)?.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
      return new Date(exp * 1000);
    }
  } catch {
    // Not JSON, not base64url, or not an object — fall through.
  }
  return fallback;
}
