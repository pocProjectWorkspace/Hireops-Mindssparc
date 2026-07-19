import type { EmailMessage, EmailProvider, EmailSendResult } from "./types";

/**
 * Resend email provider — real HTTP delivery via Resend's REST API.
 *
 * Deliberately dependency-free: a plain `fetch` to POST /emails rather
 * than the `resend` SDK, so this package stays install-light and the
 * Node 22 global fetch is the only runtime requirement.
 *
 * Error contract (read apps/workers/src/lib/dispatcher.ts): this provider
 * does NOT retry. It throws on any failure (non-2xx, malformed 2xx,
 * network error, timeout) and lets the dispatcher's outbox machinery
 * decide retry-vs-fail. The dispatcher increments attempt_count on claim
 * and, on a thrown error, re-queues the row to 'pending' until
 * attempt_count >= attemptCap (default 5), then marks it 'failed'. Adding
 * backoff/retry here would double up on that and is out of scope.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_CHARS = 500;

export interface ResendEmailProviderOptions {
  /** Resend API key (RESEND_API_KEY). Must be non-empty. */
  apiKey: string;
  /** From address, e.g. "HireOps <no-reply@notifications.example.com>". Must be non-empty. */
  from: string;
}

export class ResendEmailProvider implements EmailProvider {
  readonly provider = "resend" as const;
  private readonly apiKey: string;
  private readonly from: string;

  constructor(opts: ResendEmailProviderOptions) {
    if (!opts.apiKey || opts.apiKey.trim() === "") {
      throw new Error("ResendEmailProvider requires a non-empty apiKey (set RESEND_API_KEY).");
    }
    if (!opts.from || opts.from.trim() === "") {
      throw new Error(
        "ResendEmailProvider requires a non-empty from address (set EMAIL_FROM, " +
          "e.g. 'HireOps <no-reply@notifications.example.com>').",
      );
    }
    this.apiKey = opts.apiKey;
    this.from = opts.from;
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          // A13 — Resend's attachment contract: [{ filename, content(base64) }].
          // Carries the real interview .ics when present.
          ...(msg.attachments && msg.attachments.length > 0
            ? {
                attachments: msg.attachments.map((a) => ({
                  filename: a.filename,
                  content: a.content,
                  content_type: a.contentType,
                })),
              }
            : {}),
        }),
        // Hard cap so a hung request can't wedge the worker's drain loop.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // AbortSignal.timeout fires a TimeoutError; DNS/connection errors also land here.
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`Resend request failed before a response (${reason}).`);
    }

    if (!res.ok) {
      const body = await readBodySafely(res);
      const truncated =
        body.length > MAX_ERROR_BODY_CHARS
          ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…[truncated]`
          : body;
      throw new Error(`Resend send failed: HTTP ${res.status} ${res.statusText} — ${truncated}`);
    }

    const payload = (await res.json()) as { id?: unknown };
    if (typeof payload.id !== "string" || payload.id === "") {
      throw new Error(
        `Resend returned ${res.status} without a message id (body: ${JSON.stringify(payload).slice(
          0,
          MAX_ERROR_BODY_CHARS,
        )}).`,
      );
    }
    return { providerMessageId: payload.id };
  }
}

async function readBodySafely(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<failed to read response body>";
  }
}
