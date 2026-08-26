/**
 * Pluggable object-storage interface. Same three-tier pattern as
 * @hireops/db's KMS client and @hireops/ai-client's AIClient:
 *   - SupabaseStorageClient — production, wraps @supabase/supabase-js
 *   - LocalStorageClient    — in-memory, used in tests and dev
 *   - getStorageClient()    — factory dispatched by STORAGE_PROVIDER env
 *
 * The interface is intentionally small. Resume-style uploads were the
 * only consumer until N3.2; signed URLs landed with the notetaker, which
 * is the feature the original "when a feature needs them" note was
 * waiting for. Lifecycle policies are still absent — see the retention
 * note on createSignedReadUrl.
 */

export interface StoragePutOpts {
  contentType: string;
  cacheControl?: string;
}

export interface StorageObject {
  buffer: Buffer;
  contentType: string;
}

/**
 * Metadata about a stored object WITHOUT its bytes (N3.4a).
 *
 * Exists because the upload-complete path has to answer two questions —
 * "did the object actually land?" and "how big is it really?" — about a file
 * that may be 250MB. get() answers both, but on the Supabase tier it does so
 * by downloading the whole thing into the API's heap, which is precisely the
 * cost the direct-to-storage upload was designed to avoid. Doing it there
 * would also mean the same bytes cross the wire twice more: once here and
 * once again when the drain fetches them.
 *
 * `sizeBytes` is the vendor's number, not the client's declaration. That
 * distinction is the reason the method exists: a browser that declares 1MB
 * and PUTs 500MB must be caught, and only storage can tell us.
 */
export interface StorageObjectStat {
  key: string;
  sizeBytes: number;
  /** What storage believes the type is; may differ from what we asked for. */
  contentType: string | null;
}

/**
 * TTL policy for signed URLs (N3.2).
 *
 * A signed URL to interview audio is a bearer credential for the most
 * sensitive artefact this platform holds: an unredacted recording of a
 * conversation the candidate consented to for one narrow purpose. Anyone
 * holding the string gets the bytes — no session, no tenant check, no
 * audit trail on the read.
 *
 * Both consumers use the URL within seconds of minting it: the N3.3 drain
 * worker fetches the media, transcribes and moves on, and the N3.4 browser
 * upload posts the blob it already has in memory. Neither one benefits
 * from a long window, so the default is 15 minutes and the hard ceiling is
 * 60. Anything longer buys nothing and widens the blast radius of a URL
 * that leaks into a log line, a Sentry breadcrumb or a support ticket.
 */
export const SIGNED_URL_DEFAULT_TTL_SECONDS = 15 * 60;
export const SIGNED_URL_MAX_TTL_SECONDS = 60 * 60;

/**
 * Resolves a requested TTL against the policy above.
 *
 * CLAMPS RATHER THAN THROWS, deliberately. The alternative — rejecting an
 * over-long request — turns a security default into a runtime failure in
 * the middle of a drain-worker attempt, and the worker's only sane
 * response would be to retry with a smaller number, i.e. to do the
 * clamping itself. Since the shorter URL always works for these callers,
 * the safe outcome is the quiet one. Callers that care read `ttlSeconds`
 * back off the returned object rather than assuming they got what they
 * asked for.
 *
 * `undefined`, non-finite and non-positive inputs all fall back to the
 * default: they mean "no opinion" or "caller bug", and a 0-second URL
 * would fail confusingly far from the mistake.
 */
export function clampSignedUrlTtlSeconds(ttlSeconds?: number): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return SIGNED_URL_DEFAULT_TTL_SECONDS;
  }
  return Math.min(Math.floor(ttlSeconds), SIGNED_URL_MAX_TTL_SECONDS);
}

export interface SignedUrlOpts {
  /**
   * Requested lifetime. Omit to take SIGNED_URL_DEFAULT_TTL_SECONDS;
   * anything above SIGNED_URL_MAX_TTL_SECONDS is clamped, not rejected.
   */
  ttlSeconds?: number;
}

export interface SignedUploadUrlOpts extends SignedUrlOpts {
  /**
   * Allow the URL to overwrite an existing object at `key`. Default false,
   * matching put()'s `upsert: false` — the notetaker composes keys from a
   * UUID, so a collision means a bug, not a re-upload.
   */
  upsert?: boolean;
}

export interface SignedUrl {
  /** The URL itself. Treat as a secret; never log it whole. */
  url: string;
  /** The object key it was minted for, echoed back for logging/correlation. */
  key: string;
  /** When the URL stops working. Authoritative — see `ttlSeconds`. */
  expiresAt: Date;
  /**
   * The lifetime actually granted, which is NOT necessarily what the
   * caller asked for: it may have been clamped by policy, and on the
   * upload path Supabase fixes the window itself (see supabase.ts).
   */
  ttlSeconds: number;
  /**
   * Which tier minted it. Present so a caller — or a human reading a log —
   * can tell a real Supabase URL from the local tier's obviously-fake one
   * without pattern-matching on the string.
   */
  provider: "supabase" | "local";
}

export interface SignedUploadUrl extends SignedUrl {
  /** HTTP method the URL expects. Supabase's signed upload endpoint is a PUT. */
  method: "PUT";
  /**
   * Supabase hands back an opaque token alongside the URL; it is already
   * embedded in `url` as a query parameter, but supabase-js's
   * `uploadToSignedUrl(path, token, body)` takes it separately, so a
   * browser client using the SDK rather than raw fetch needs it. Null on
   * tiers that have no such concept.
   */
  token: string | null;
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
   * Returns size + type for the object at key WITHOUT fetching it. Throws
   * StorageNotFoundError if absent, exactly as get() does, so the caller
   * keeps the same 404-vs-500 distinction.
   *
   * This is the existence + size check N3.4a's upload-complete runs before
   * it enqueues: the browser PUT the bytes out-of-band, so "the client says
   * it uploaded" is the only other evidence available, and it is not
   * evidence.
   */
  stat(key: string): Promise<StorageObjectStat>;

  /**
   * Deletes the object at key. No-op if absent. Used by cleanup paths
   * (e.g. submitApplication rollback on parse failure if we add that).
   */
  delete(key: string): Promise<void>;

  /**
   * Mints a short-lived URL that reads the object at key.
   *
   * Exists because the N3.3 transcript drain fetches interview media
   * out-of-band: the worker (and, later, whatever ASR vendor we hand a URL
   * to instead of bytes) is not inside the API's auth context, and
   * streaming a 100MB recording back through a tRPC procedure to hand it
   * to another process would be absurd.
   *
   * Throws StorageNotFoundError when the object does not exist, so callers
   * get the same 404-vs-500 distinction get() gives them, and StorageError
   * on transport failure.
   *
   * RETENTION NOTE (not implemented here): interview audio is a transient
   * artefact — retained per tenant policy (settings.retentionPolicy
   * .interviewAudioDays, default 30, hard ceiling 90) while
   * transcripts are kept indefinitely. A later ticket adds
   * `media_purged_at` plus a sweep worker; this method will simply start
   * throwing StorageNotFoundError for purged recordings, which is exactly
   * how callers should already be treating a missing object.
   */
  createSignedReadUrl(key: string, opts?: SignedUrlOpts): Promise<SignedUrl>;

  /**
   * Mints a short-lived URL that accepts a PUT of the object at key.
   *
   * Exists for N3.4's in-browser capture: a MediaRecorder blob for a
   * one-hour interview is two orders of magnitude larger than the resume
   * the multipart routes were built for, and pushing it through the API
   * process would mean buffering the whole thing in Node's heap on a
   * container sized for JSON. Direct-to-storage keeps the API out of the
   * byte path entirely; the API still authorises the upload (it is what
   * mints the URL and what records the recording row).
   *
   * Note that `key` is chosen by the API, never by the browser — the URL
   * grants write access to exactly one path.
   */
  createSignedUploadUrl(key: string, opts?: SignedUploadUrlOpts): Promise<SignedUploadUrl>;
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
