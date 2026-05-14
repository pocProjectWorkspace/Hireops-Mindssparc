import { AwsKmsClient } from "./aws";
import { LocalKmsClient } from "./local";
import type { KmsClient } from "./types";

export type { KmsClient };
export { LocalKmsClient, AwsKmsClient };

/**
 * Returns the KMS client configured for this process. Defaults to the local
 * implementation; switch to AWS by setting KMS_PROVIDER=aws and
 * AWS_KMS_KEY_ARN to the master key ARN.
 *
 * Throws on misconfiguration so secrets-handling code can't silently fall
 * back to an inert client.
 */
export function getKmsClient(): KmsClient {
  const provider = process.env.KMS_PROVIDER ?? "local";

  if (provider === "local") {
    const kek = process.env.SUPABASE_KEK_SECRET;
    if (!kek) {
      throw new Error("SUPABASE_KEK_SECRET is not set. Required for local KMS.");
    }
    return new LocalKmsClient(kek);
  }

  if (provider === "aws") {
    const arn = process.env.AWS_KMS_KEY_ARN;
    if (!arn) {
      throw new Error("AWS_KMS_KEY_ARN is not set. Required for AWS KMS.");
    }
    return new AwsKmsClient(arn);
  }

  throw new Error(`Unknown KMS_PROVIDER: ${provider}. Expected 'local' or 'aws'.`);
}
