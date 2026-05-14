import type { KmsClient } from "./types";

/**
 * Stub for the AWS KMS client. Real implementation lands when the ops
 * tooling does. The interface is the same as LocalKmsClient, so swapping
 * is a single env-var change (KMS_PROVIDER=aws) once this throws is
 * replaced with a real @aws-sdk/client-kms-backed implementation.
 */
export class AwsKmsClient implements KmsClient {
  readonly kmsKeyId: string;

  constructor(kmsKeyArn: string) {
    this.kmsKeyId = kmsKeyArn;
  }

  wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    return Promise.reject(
      new Error(
        `AwsKmsClient.wrap not yet implemented (got ${plaintext.byteLength}-byte plaintext) — use LocalKmsClient (KMS_PROVIDER=local) for dev`,
      ),
    );
  }

  unwrap(ciphertext: Uint8Array): Promise<Uint8Array> {
    return Promise.reject(
      new Error(
        `AwsKmsClient.unwrap not yet implemented (got ${ciphertext.byteLength}-byte ciphertext) — use LocalKmsClient (KMS_PROVIDER=local) for dev`,
      ),
    );
  }
}
