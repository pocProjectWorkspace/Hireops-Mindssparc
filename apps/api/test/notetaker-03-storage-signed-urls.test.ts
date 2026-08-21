/**
 * N3.2 tests for storage signed URLs + the media/document size caps.
 *
 * Coverage (13 cases):
 *   1. A signed read URL round-trips on the local tier: mint → resolve →
 *      identical bytes and content type
 *   2. The local URL is unmistakably fake — local:// scheme, provider
 *      "local", not an https string anyone could mistake for Supabase
 *   3. Default TTL is 15 minutes when the caller expresses no opinion
 *   4. A TTL above the ceiling is clamped to 60 minutes, not rejected;
 *      clampSignedUrlTtlSeconds covers the raw policy
 *   5. An expired URL fails closed at resolve time
 *   6. A tampered URL (edited key / stretched expiry) fails the signature
 *   7. A read URL cannot be used to upload and vice versa
 *   8. A read URL for a missing object raises StorageNotFoundError, the
 *      same 404-vs-500 distinction get() gives callers
 *   9. A signed upload URL round-trips: mint → write → get
 *  10. Minting an upload URL over an existing object needs upsert
 *  11. The media cap: default 250MB, env-overridable, garbage ignored
 *  12. The audio MIME allow-list, including MediaRecorder's
 *      "audio/webm;codecs=opus" parameterised form and a rejected PDF
 *  13. REGRESSION GUARD — the resume route still refuses anything over
 *      10MB and still accepts a 10MB PDF. This ticket must not loosen the
 *      document path, so this case exercises the real Hono route rather
 *      than the constant.
 *
 * No database, no network, no Supabase: every case runs on the local tier
 * (NODE_ENV=test) or on pure functions.
 */

import "../src/bootstrap";

import { afterEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import {
  clampSignedUrlTtlSeconds,
  LocalStorageClient,
  parseLocalSignedUrl,
  resetStorageClient,
  resolveLocalSignedUrl,
  writeLocalSignedUploadUrl,
  SIGNED_URL_DEFAULT_TTL_SECONDS,
  SIGNED_URL_MAX_TTL_SECONDS,
  StorageError,
  StorageNotFoundError,
} from "../src/lib/storage";
import {
  ALLOWED_AUDIO_TYPES,
  DEFAULT_MAX_MEDIA_BYTES,
  MAX_DOCUMENT_BYTES,
  isAllowedAudioType,
  maxMediaBytes,
  normaliseMediaContentType,
} from "../src/lib/upload-limits";
import { uploadRoutes } from "../src/routes/upload";

const BUCKET = "notetaker-test-bucket";
const MEDIA_KEY = "interview-media/00000000-0000-0000-0000-0000000n3201-recording.webm";
const AUDIO = Buffer.from("fake-opus-bytes-standing-in-for-an-interview-recording");

function client(): LocalStorageClient {
  return new LocalStorageClient({ bucket: BUCKET });
}

afterEach(() => {
  // Clears the module-level map AND the getStorageClient singleton.
  resetStorageClient();
  delete process.env.MEDIA_MAX_UPLOAD_BYTES;
});

describe("N3.2 signed read URLs (local tier)", () => {
  it("round-trips: mint → resolve → same bytes", async () => {
    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });

    const signed = await storage.createSignedReadUrl(MEDIA_KEY);
    assert.equal(signed.key, MEDIA_KEY);

    // This is the path N3.3's drain worker takes: it holds a URL, not a
    // handle, and pulls the media out-of-band.
    const fetched = resolveLocalSignedUrl(signed.url);
    assert.ok(fetched.buffer.equals(AUDIO), "resolved bytes must match what was stored");
    assert.equal(fetched.contentType, "audio/webm");
  });

  it("is obviously not a real URL", async () => {
    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });
    const signed = await storage.createSignedReadUrl(MEDIA_KEY);

    assert.equal(signed.provider, "local");
    assert.ok(signed.url.startsWith("local://signed/"), signed.url);
    assert.ok(!signed.url.includes("http"), "must not look fetchable");
    assert.ok(!signed.url.includes("supabase"), "must not look like Supabase");
    // The key and the expiry are both encoded in the string.
    const parsed = parseLocalSignedUrl(signed.url, "read");
    assert.equal(parsed.key, MEDIA_KEY);
    assert.equal(parsed.bucket, BUCKET);
    assert.equal(parsed.expiresAt.getTime(), signed.expiresAt.getTime());
  });

  it("defaults to a 15-minute TTL", async () => {
    assert.equal(SIGNED_URL_DEFAULT_TTL_SECONDS, 15 * 60);

    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });
    const before = Date.now();
    const signed = await storage.createSignedReadUrl(MEDIA_KEY);

    assert.equal(signed.ttlSeconds, 15 * 60);
    const deltaMs = signed.expiresAt.getTime() - before;
    assert.ok(
      deltaMs > 14 * 60 * 1000 && deltaMs <= 15 * 60 * 1000 + 1000,
      `expiresAt should be ~15 min out, got ${deltaMs}ms`,
    );
  });

  it("clamps an over-long TTL to the 60-minute ceiling instead of throwing", async () => {
    assert.equal(SIGNED_URL_MAX_TTL_SECONDS, 60 * 60);

    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });

    // A caller asking for a week gets an hour, quietly, and can see that
    // it was clamped by reading ttlSeconds back.
    const signed = await storage.createSignedReadUrl(MEDIA_KEY, { ttlSeconds: 7 * 24 * 3600 });
    assert.equal(signed.ttlSeconds, 60 * 60);
    const deltaMs = signed.expiresAt.getTime() - Date.now();
    assert.ok(deltaMs <= 60 * 60 * 1000 + 1000, `expiry must not exceed the ceiling: ${deltaMs}`);

    // A shorter request is honoured as asked.
    const short = await storage.createSignedReadUrl(MEDIA_KEY, { ttlSeconds: 30 });
    assert.equal(short.ttlSeconds, 30);

    // Policy function directly.
    assert.equal(clampSignedUrlTtlSeconds(undefined), SIGNED_URL_DEFAULT_TTL_SECONDS);
    assert.equal(clampSignedUrlTtlSeconds(120), 120);
    assert.equal(
      clampSignedUrlTtlSeconds(SIGNED_URL_MAX_TTL_SECONDS + 1),
      SIGNED_URL_MAX_TTL_SECONDS,
    );
    assert.equal(clampSignedUrlTtlSeconds(Number.MAX_SAFE_INTEGER), SIGNED_URL_MAX_TTL_SECONDS);
    assert.equal(clampSignedUrlTtlSeconds(0), SIGNED_URL_DEFAULT_TTL_SECONDS);
    assert.equal(clampSignedUrlTtlSeconds(-60), SIGNED_URL_DEFAULT_TTL_SECONDS);
    assert.equal(clampSignedUrlTtlSeconds(Number.NaN), SIGNED_URL_DEFAULT_TTL_SECONDS);
    assert.equal(clampSignedUrlTtlSeconds(90.7), 90);
  });

  it("stops working once expired", async () => {
    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });
    const signed = await storage.createSignedReadUrl(MEDIA_KEY, { ttlSeconds: 60 });

    const afterExpiry = new Date(signed.expiresAt.getTime() + 1000);
    assert.throws(
      () => resolveLocalSignedUrl(signed.url, { now: afterExpiry }),
      (err: unknown) => err instanceof StorageError && /expired/i.test((err as Error).message),
    );
    // Still valid a second before.
    const beforeExpiry = new Date(signed.expiresAt.getTime() - 1000);
    assert.ok(resolveLocalSignedUrl(signed.url, { now: beforeExpiry }).buffer.equals(AUDIO));
  });

  it("rejects a tampered URL", async () => {
    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });
    await storage.put("interview-media/someone-elses-recording.webm", Buffer.from("secret"), {
      contentType: "audio/webm",
    });
    const signed = await storage.createSignedReadUrl(MEDIA_KEY);

    const swappedKey = signed.url.replace(
      encodeURIComponent(MEDIA_KEY),
      encodeURIComponent("interview-media/someone-elses-recording.webm"),
    );
    assert.throws(
      () => resolveLocalSignedUrl(swappedKey),
      (err: unknown) => err instanceof StorageError && /signature/i.test((err as Error).message),
    );

    const stretched = signed.url.replace(
      /exp=\d+/,
      `exp=${Math.floor(Date.now() / 1000) + 30 * 24 * 3600}`,
    );
    assert.throws(
      () => resolveLocalSignedUrl(stretched),
      (err: unknown) => err instanceof StorageError && /signature/i.test((err as Error).message),
    );

    assert.throws(
      () => resolveLocalSignedUrl("https://example.supabase.co/storage/v1/object/sign/x?token=y"),
      (err: unknown) => err instanceof StorageError,
    );
  });

  it("does not let a read URL upload, or an upload URL read", async () => {
    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });
    const read = await storage.createSignedReadUrl(MEDIA_KEY);
    const upload = await storage.createSignedUploadUrl("interview-media/new.webm");

    assert.throws(
      () => writeLocalSignedUploadUrl(read.url, Buffer.from("nope")),
      (err: unknown) => err instanceof StorageError && /'read'/.test((err as Error).message),
    );
    assert.throws(
      () => resolveLocalSignedUrl(upload.url),
      (err: unknown) => err instanceof StorageError && /'upload'/.test((err as Error).message),
    );
  });

  it("raises StorageNotFoundError for an object that is not there", async () => {
    const storage = client();
    await assert.rejects(
      () => storage.createSignedReadUrl("interview-media/never-uploaded.webm"),
      (err: unknown) => err instanceof StorageNotFoundError,
    );

    // And for an object deleted after the URL was minted — which is what a
    // 30-day media purge will look like to a stale URL holder.
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });
    const signed = await storage.createSignedReadUrl(MEDIA_KEY);
    await storage.delete(MEDIA_KEY);
    assert.throws(
      () => resolveLocalSignedUrl(signed.url),
      (err: unknown) => err instanceof StorageNotFoundError,
    );
  });
});

describe("N3.2 signed upload URLs (local tier)", () => {
  it("round-trips: mint → write → get", async () => {
    const storage = client();
    const signed = await storage.createSignedUploadUrl(MEDIA_KEY, { ttlSeconds: 30 * 60 });

    assert.equal(signed.provider, "local");
    assert.equal(signed.method, "PUT");
    assert.equal(signed.token, null);
    assert.equal(signed.ttlSeconds, 30 * 60);
    assert.ok(signed.url.startsWith("local://signed/"), signed.url);

    // Stands in for N3.4's browser PUT of a MediaRecorder blob.
    writeLocalSignedUploadUrl(signed.url, AUDIO, { contentType: "audio/webm" });

    const stored = await storage.get(MEDIA_KEY);
    assert.ok(stored.buffer.equals(AUDIO));
    assert.equal(stored.contentType, "audio/webm");
  });

  it("refuses to mint over an existing object unless upsert is asked for", async () => {
    const storage = client();
    await storage.put(MEDIA_KEY, AUDIO, { contentType: "audio/webm" });

    await assert.rejects(
      () => storage.createSignedUploadUrl(MEDIA_KEY),
      (err: unknown) =>
        err instanceof StorageError && /already exists/.test((err as Error).message),
    );
    const withUpsert = await storage.createSignedUploadUrl(MEDIA_KEY, { upsert: true });
    writeLocalSignedUploadUrl(withUpsert.url, Buffer.from("replacement"), {
      contentType: "audio/webm",
    });
    assert.equal((await storage.get(MEDIA_KEY)).buffer.toString(), "replacement");
  });
});

describe("N3.2 upload limits", () => {
  it("caps media at 250MB by default and honours the env override", () => {
    assert.equal(DEFAULT_MAX_MEDIA_BYTES, 250 * 1024 * 1024);
    assert.equal(maxMediaBytes(), 250 * 1024 * 1024);

    // A 60-minute AAC/MP3 export (~58MB) passes; a 300MB blob does not.
    const oneHourCompressed = Math.round((128_000 * 3600) / 8);
    assert.ok(oneHourCompressed <= maxMediaBytes(), "a normal one-hour recording must fit");
    assert.ok(300 * 1024 * 1024 > maxMediaBytes(), "an over-cap upload must be rejected");

    process.env.MEDIA_MAX_UPLOAD_BYTES = String(400 * 1024 * 1024);
    assert.equal(maxMediaBytes(), 400 * 1024 * 1024);

    // A typo'd override must not silently disable the cap.
    process.env.MEDIA_MAX_UPLOAD_BYTES = "unlimited";
    assert.equal(maxMediaBytes(), DEFAULT_MAX_MEDIA_BYTES);
    process.env.MEDIA_MAX_UPLOAD_BYTES = "-1";
    assert.equal(maxMediaBytes(), DEFAULT_MAX_MEDIA_BYTES);
  });

  it("accepts the audio types the capture paths actually produce", () => {
    // MediaRecorder hands back codec parameters; a naive Set.has() on this
    // string would reject our own browser capture path.
    assert.equal(normaliseMediaContentType("audio/webm;codecs=opus"), "audio/webm");
    assert.equal(normaliseMediaContentType(" AUDIO/WEBM "), "audio/webm");
    assert.ok(isAllowedAudioType("audio/webm;codecs=opus"));

    for (const type of ["audio/webm", "audio/m4a", "audio/mpeg", "audio/wav"]) {
      assert.ok(isAllowedAudioType(type), `${type} must be accepted`);
      assert.ok(ALLOWED_AUDIO_TYPES.has(type));
    }
    for (const type of ["application/pdf", "video/mp4", "text/plain", ""]) {
      assert.ok(!isAllowedAudioType(type), `${type} must be rejected`);
    }
  });

  it("REGRESSION: the resume route is still capped at 10MB", async () => {
    assert.equal(MAX_DOCUMENT_BYTES, 10 * 1024 * 1024);
    assert.ok(
      MAX_DOCUMENT_BYTES < DEFAULT_MAX_MEDIA_BYTES,
      "the media cap must be separate from — not a replacement for — the document cap",
    );

    const tooBig = new FormData();
    tooBig.append(
      "file",
      new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "huge.pdf", {
        type: "application/pdf",
      }),
    );
    const rejected = await uploadRoutes.request("/resume", { method: "POST", body: tooBig });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: "file_too_large",
      maxBytes: 10 * 1024 * 1024,
    });

    // …and a document at exactly the cap still goes through, so the guard
    // did not tighten either.
    const atCap = new FormData();
    atCap.append(
      "file",
      new File([new Uint8Array(MAX_DOCUMENT_BYTES)], "portfolio.pdf", {
        type: "application/pdf",
      }),
    );
    const accepted = await uploadRoutes.request("/resume", { method: "POST", body: atCap });
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as { storageKey: string; sizeBytes: number };
    assert.equal(body.sizeBytes, MAX_DOCUMENT_BYTES);
    assert.ok(body.storageKey.startsWith("resumes/"));
  });
});
