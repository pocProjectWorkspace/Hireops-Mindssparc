/**
 * Public types for @hireops/notifications.
 *
 * Pluggable provider pattern matching ai-client / storage:
 *   - EmailProvider — interface
 *   - LocalEmailProvider — writes to dev_email_outbox (no real send)
 *   - ResendEmailProvider — real HTTP delivery via Resend's REST API
 *
 * The worker (apps/workers) is the only consumer of EmailProvider; the
 * api never sends directly. Mutations enqueue via enqueueNotification(),
 * the worker dispatches.
 */

export type EmailRecipientType = "candidate" | "recruiter" | "hiring_manager";

/**
 * Template keys Wave 1 ships. Adding a key requires:
 *   1. Add the literal here
 *   2. Add a template file under @hireops/email-templates
 *   3. Update the dispatcher's switch
 *
 * Forcing all three is intentional — silent fallback to a "default"
 * template would surface as customers receiving the wrong copy.
 */
export type TemplateKey =
  | "candidate.application_received"
  | "candidate.stage_advanced"
  | "candidate.offer_extended"
  | "candidate.interview_invitation"
  | "candidate.account_activation"
  | "candidate.agent_message"
  | "recruiter.sla_breach_imminent"
  | "recruiter.offer_accepted"
  | "recruiter.offer_declined";

export interface EmailMessage {
  /** Render target. */
  to: string;
  /** Pre-rendered subject — caller already substituted template_data. */
  subject: string;
  /** Pre-rendered HTML body. */
  html: string;
  /** Pre-rendered plain-text body (mandatory; fall-through for clients that block HTML). */
  text: string;
  /** Provenance for dev_email_outbox + structured logs. */
  templateKey: TemplateKey;
  /** Tenant for dev_email_outbox row scope. */
  tenantId: string;
  /** Back-reference to the notification_outbox row that drove this send. */
  outboxId: string | null;
}

export interface EmailSendResult {
  /**
   * Provider message id. LocalEmailProvider returns "local-<uuid>" so
   * the column has a non-empty value and worker logging can show it
   * without a special case.
   */
  providerMessageId: string;
}

export interface EmailProvider {
  /** "local" (dev/test), "resend" (real), or "ses" (reserved for a future provider). */
  readonly provider: "local" | "ses" | "resend";
  send(msg: EmailMessage): Promise<EmailSendResult>;
}
