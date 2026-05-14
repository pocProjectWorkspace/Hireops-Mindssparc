import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsClient } from "./kms";

/**
 * Envelope encryption helpers per architecture.md §5.1.
 *
 * Wire format for both wrapped DEKs (LocalKmsClient) and application
 * payloads (encryptWithDek): `iv (12) || authTag (16) || ciphertext (N)`.
 * One layout means one parser; keep it that way.
 *
 * AES-256-GCM throughout. 32-byte keys, 12-byte random IV per encryption,
 * 16-byte authentication tag. IV is generated fresh per call — never
 * reuse an (IV, key) pair, that's catastrophic for GCM.
 */

const IV_LEN = 12;
const TAG_LEN = 16;

export function generateDek(): Uint8Array {
  return randomBytes(32);
}

export async function wrapDek(
  dek: Uint8Array,
  kms: KmsClient,
): Promise<{ encryptedDek: Uint8Array; kmsKeyId: string }> {
  const encryptedDek = await kms.wrap(dek);
  return { encryptedDek, kmsKeyId: kms.kmsKeyId };
}

export async function unwrapDek(
  encryptedDek: Uint8Array,
  expectedKmsKeyId: string,
  kms: KmsClient,
): Promise<Uint8Array> {
  if (kms.kmsKeyId !== expectedKmsKeyId) {
    throw new Error(
      `KMS key mismatch: wrapped with "${expectedKmsKeyId}", current client is "${kms.kmsKeyId}"`,
    );
  }
  return kms.unwrap(encryptedDek);
}

export function encryptWithDek(plaintext: Uint8Array | string, dek: Uint8Array): Uint8Array {
  if (dek.byteLength !== 32) {
    throw new Error(`DEK must be 32 bytes, got ${dek.byteLength}`);
  }
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptWithDek(envelope: Uint8Array, dek: Uint8Array): Uint8Array {
  if (dek.byteLength !== 32) {
    throw new Error(`DEK must be 32 bytes, got ${dek.byteLength}`);
  }
  if (envelope.byteLength < IV_LEN + TAG_LEN) {
    throw new Error(
      `Envelope too short: ${envelope.byteLength} bytes (need at least ${IV_LEN + TAG_LEN})`,
    );
  }
  const buf = Buffer.from(envelope);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function decryptStringWithDek(envelope: Uint8Array, dek: Uint8Array): string {
  return Buffer.from(decryptWithDek(envelope, dek)).toString("utf8");
}
