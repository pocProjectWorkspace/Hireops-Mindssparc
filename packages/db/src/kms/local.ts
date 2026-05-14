import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsClient } from "./types";

/**
 * Local KMS implementation. Uses AES-256-GCM with SUPABASE_KEK_SECRET as the
 * master key. Suitable for dev only — production uses AwsKmsClient against
 * a real KMS-managed master key.
 *
 * Wire format: `iv (12 bytes) || authTag (16 bytes) || ciphertext (variable)`.
 * Same layout used elsewhere in the envelope helpers — keeping it consistent
 * means there's one parser to maintain.
 *
 * The kmsKeyId stored in tenant_encryption_keys.kms_key_id alongside each
 * wrapped DEK is the literal string `"local:v1"`. If we ever ship a v2
 * local implementation (different AEAD scheme, different KEK derivation),
 * bump the suffix and decide on a migration strategy at that time.
 */
export class LocalKmsClient implements KmsClient {
  readonly kmsKeyId = "local:v1";
  private readonly key: Buffer;

  constructor(kekHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(kekHex)) {
      throw new Error("SUPABASE_KEK_SECRET must be 64 hex characters (32 bytes)");
    }
    this.key = Buffer.from(kekHex, "hex");
  }

  wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Promise.resolve(Buffer.concat([iv, tag, ct]));
  }

  unwrap(wrapped: Uint8Array): Promise<Uint8Array> {
    const buf = Buffer.from(wrapped);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Promise.resolve(Buffer.concat([decipher.update(ct), decipher.final()]));
  }
}
