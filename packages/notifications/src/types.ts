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

/**
 * Who the email is addressed to. Stored verbatim in
 * notification_outbox.recipient_type (a free-text column — no DB enum, no
 * CHECK), so this union is the only place the vocabulary is fixed.
 *
 * "partner" (P0.1A) is a staffing-agency contact who is NOT yet a
 * partner_users row — the invitation email is precisely what turns them into
 * one, so neither "candidate" nor "recruiter" would be honest. P0.4 reuses the
 * same value for the three emails addressed to an EXISTING partner user.
 */
export type EmailRecipientType = "candidate" | "recruiter" | "hiring_manager" | "partner";

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
  | "candidate.interview_cancelled"
  | "candidate.account_activation"
  | "candidate.agent_message"
  | "recruiter.sla_breach_imminent"
  | "recruiter.sla_ops_alert"
  // R1.5a — the scheduled board-pack digest. "recruiter." is the ops-facing
  // prefix (as with sla_ops_alert); the actual recipients are the mailboxes an
  // admin nominated, which need not be HireOps users.
  | "recruiter.report_digest"
  | "recruiter.offer_accepted"
  | "recruiter.offer_declined"
  | "partner.invitation"
  // P0.4 — the three partner-facing lifecycle emails. Each carries stage /
  // date / candidate name only (requirements.md §6.3); nothing internal.
  | "partner.submission_received"
  | "partner.stage_changed"
  | "partner.claim_expiry_warning";

/**
 * A file attached to an outgoing email. Content is base64 (matches Resend's
 * REST attachment contract, and keeps the type provider-agnostic). Wave-1 use:
 * the honest `.ics` calendar file on interview invitations (A13) — a REAL
 * generated VEVENT, no third-party calendar API.
 */
export interface EmailAttachment {
  /** File name the client shows, e.g. "interview.ics". */
  filename: string;
  /** Base64-encoded file content. */
  content: string;
  /** MIME type, e.g. "text/calendar". */
  contentType: string;
}

export interface EmailMessage {
  /** Render target. */
  to: string;
  /** Pre-rendered subject — caller already substituted template_data. */
  subject: string;
  /** Pre-rendered HTML body. */
  html: string;
  /** Pre-rendered plain-text body (mandatory; fall-through for clients that block HTML). */
  text: string;
  /** Optional file attachments (e.g. the interview .ics). Providers that can't
   * carry attachments (LocalEmailProvider) note them but don't fail. */
  attachments?: EmailAttachment[];
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
