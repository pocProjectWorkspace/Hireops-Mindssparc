import { createHash } from "node:crypto";
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
 * In-process Map-backed Storage. Used in tests + when STORAGE_PROVIDER is
 * unset locally. Survives a single Node process; not durable.
 *
 * Reset between tests via resetLocalStorage() — vitest fork-pool isolates
 * files, but within a file we want a clean slate before each test that
 * touches storage.
 */

let store = new Map<string, StorageObject>();

/**
 * Scheme for the local tier's signed URLs (N3.2).
 *
 * This tier has no HTTP surface, so it cannot mint a URL anything will
 * fetch. Rather than fake a plausible https:// string — which would sooner
 * or later be pasted into a browser, or worse, into a bug report as
 * evidence that "storage works" — the local tier emits an unmistakably
 * non-network scheme. Nothing outside this module can dereference it, and
 * a reader cannot mistake it for Supabase.
 *
 * Shape:
 *   local://signed/<bucket>/<uri-encoded key>?op=read&exp=<epoch>&sig=<hex>
 *
 * It is round-trippable on purpose: resolveLocalSignedUrl() takes the
 * string back and returns the stored object, and writeLocalSignedUploadUrl()
 * takes an upload URL plus bytes and stores them. That is what lets N3.3's
 * drain tests exercise "fetch the media by signed URL, transcribe it" and
 * N3.4's upload tests exercise "browser PUTs to the URL the API minted",
 * both with no network and no Supabase.
 */
const LOCAL_SIGNED_URL_PREFIX = "local://signed/";

/**
 * Not a security boundary — it is a constant in a file you are reading.
 * The signature exists so the round-trip helpers can reject a URL that has
 * been hand-edited in a test (a tampered key or a stretched expiry) instead
 * of silently honouring it, which would let a bug in the URL-building code
 * pass its own test.
 */
const LOCAL_SIGNING_SALT = "hireops-local-storage-fake-signature";

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

  /**
   * Existence is checked here, not at resolve time, because the Supabase
   * tier's createSignedUrl 404s on a missing object too — a caller that
   * only ever runs against the local tier in tests would otherwise not
   * discover the StorageNotFoundError path until production.
   */
  async createSignedReadUrl(key: string, opts?: SignedUrlOpts): Promise<SignedUrl> {
    if (!store.has(this.scope(key))) throw new StorageNotFoundError(key);
    return this.mint("read", key, opts?.ttlSeconds);
  }

  /**
   * The reverse: the object must NOT exist unless upsert was asked for,
   * mirroring put()/Supabase's `upsert: false` default.
   */
  async createSignedUploadUrl(key: string, opts?: SignedUploadUrlOpts): Promise<SignedUploadUrl> {
    if (!opts?.upsert && store.has(this.scope(key))) {
      throw new StorageError(`Local signed upload URL: object already exists at ${key}`);
    }
    const signed = this.mint("upload", key, opts?.ttlSeconds);
    // `method` matches the real tier so N3.4's client code is written once;
    // `token` is null because there is no vendor token to hand back — the
    // whole credential is the URL.
    return { ...signed, method: "PUT", token: null };
  }

  private mint(op: LocalSignedOp, key: string, ttlSeconds: number | undefined): SignedUrl {
    const ttl = clampSignedUrlTtlSeconds(ttlSeconds);
    // Second precision, matching Supabase's expiresIn — and it keeps the
    // URL deterministic for a given (op, bucket, key, expiry) so a test can
    // assert on the exact string.
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttl;
    const sig = localSignature(op, this.bucket, key, expiresAtSeconds);
    const url =
      `${LOCAL_SIGNED_URL_PREFIX}${encodeURIComponent(this.bucket)}/${encodeURIComponent(key)}` +
      `?op=${op}&exp=${expiresAtSeconds}&sig=${sig}`;
    return {
      url,
      key,
      expiresAt: new Date(expiresAtSeconds * 1000),
      ttlSeconds: ttl,
      provider: "local",
    };
  }

  private scope(key: string): string {
    return `${this.bucket}:${key}`;
  }
}

export function resetLocalStorage(): void {
  store = new Map();
}

type LocalSignedOp = "read" | "upload";

interface ParsedLocalSignedUrl {
  op: LocalSignedOp;
  bucket: string;
  key: string;
  expiresAt: Date;
}

/**
 * Dereferences a local read URL — the half of the round trip that stands in
 * for an HTTP GET. Throws StorageNotFoundError if the object has since been
 * deleted, and StorageError if the URL is malformed, expired, tampered
 * with, or is an upload URL being used to read (the `op` is signed, so the
 * two directions are not interchangeable, same as on Supabase where they
 * are entirely different endpoints).
 */
export function resolveLocalSignedUrl(url: string, opts?: { now?: Date }): StorageObject {
  const parsed = parseLocalSignedUrl(url, "read", opts?.now ?? new Date());
  const got = store.get(`${parsed.bucket}:${parsed.key}`);
  if (!got) throw new StorageNotFoundError(parsed.key);
  return got;
}

/**
 * The other half: stands in for the browser's PUT to a signed upload URL.
 * Present so N3.4 can be developed and tested with STORAGE_PROVIDER=local
 * end to end rather than only against Supabase.
 */
export function writeLocalSignedUploadUrl(
  url: string,
  buffer: Buffer,
  opts?: { contentType?: string; now?: Date },
): void {
  const parsed = parseLocalSignedUrl(url, "upload", opts?.now ?? new Date());
  store.set(`${parsed.bucket}:${parsed.key}`, {
    buffer,
    // Matches Supabase, where the content type on a signed PUT comes from
    // the uploading client's header rather than from the minted URL.
    contentType: opts?.contentType ?? "application/octet-stream",
  });
}

/**
 * Exposed for tests that want to assert on expiry/key without touching the
 * store (e.g. "the clamp really shortened this URL").
 */
export function parseLocalSignedUrl(
  url: string,
  expectedOp: LocalSignedOp,
  now: Date = new Date(),
): ParsedLocalSignedUrl {
  if (!url.startsWith(LOCAL_SIGNED_URL_PREFIX)) {
    throw new StorageError(`Not a local signed URL: ${url}`);
  }
  const [pathPart, queryPart] = url.slice(LOCAL_SIGNED_URL_PREFIX.length).split("?");
  // Exactly two segments: the key is uri-encoded when minted, so its own
  // slashes ("interview-media/<uuid>.webm") survive as %2F rather than
  // splitting the path.
  const [bucketPart, keyPart, ...extraSegments] = (pathPart ?? "").split("/");
  if (!bucketPart || !keyPart || extraSegments.length > 0 || !queryPart) {
    throw new StorageError(`Malformed local signed URL: ${url}`);
  }
  const bucket = decodeURIComponent(bucketPart);
  const key = decodeURIComponent(keyPart);

  const params = new URLSearchParams(queryPart);
  const op = params.get("op");
  const exp = Number(params.get("exp"));
  const sig = params.get("sig");
  if ((op !== "read" && op !== "upload") || !Number.isFinite(exp) || !sig) {
    throw new StorageError(`Malformed local signed URL: ${url}`);
  }
  if (op !== expectedOp) {
    throw new StorageError(`Local signed URL is for '${op}', used for '${expectedOp}'`);
  }
  if (sig !== localSignature(op, bucket, key, exp)) {
    throw new StorageError("Local signed URL signature mismatch");
  }
  const expiresAt = new Date(exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new StorageError(`Local signed URL expired at ${expiresAt.toISOString()}`);
  }
  return { op, bucket, key, expiresAt };
}

function localSignature(
  op: LocalSignedOp,
  bucket: string,
  key: string,
  expiresAtSeconds: number,
): string {
  return createHash("sha256")
    .update(`${LOCAL_SIGNING_SALT}:${op}:${bucket}:${key}:${expiresAtSeconds}`)
    .digest("hex")
    .slice(0, 32);
}
