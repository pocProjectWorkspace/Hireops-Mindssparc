/**
 * KMS client interface for wrapping / unwrapping per-tenant DEKs.
 *
 * The kmsKeyId is stored alongside every wrapped DEK so future rotation
 * paths know which KMS client / which master key was used to wrap it.
 */
export interface KmsClient {
  readonly kmsKeyId: string;
  wrap(plaintext: Uint8Array): Promise<Uint8Array>;
  unwrap(ciphertext: Uint8Array): Promise<Uint8Array>;
}
