import type { EmailMessage, EmailProvider, EmailSendResult } from "./types";

/**
 * Placeholder for the real email provider. A future ticket replaces
 * this with concrete SES / Resend clients (the choice is parked — see
 * docs/open-questions.md when added).
 *
 * Today the factory rejects EMAIL_PROVIDER=real with a helpful error
 * if the env asks for it. Having the stub here keeps the factory's
 * import graph honest and the swap a one-line change in factory.ts.
 */
export class RealEmailProviderStub implements EmailProvider {
  readonly provider = "real-stub" as const;

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    void msg;
    throw new Error(
      "RealEmailProvider not implemented. " +
        "Set EMAIL_PROVIDER=local (default) until SES/Resend wiring lands.",
    );
  }
}
