import { LocalEmailProvider } from "./local";
import { ResendEmailProvider } from "./resend";
import type { EmailProvider } from "./types";

/**
 * Per-tenant resolution is a no-op in Wave 1 — every tenant uses the
 * same provider, selected via EMAIL_PROVIDER env. The tenantId param is
 * carried in the signature so a future tenant-scoped override (e.g.
 * Kyndryl wants Resend; everyone else wants SES) is a body change, not
 * a signature change in every call site.
 *
 * Defaults to "local" when EMAIL_PROVIDER is unset or NODE_ENV=test —
 * same convention as ai-client and storage. Tests always run local.
 *
 * Going live on Resend is pure configuration (no code change):
 *   EMAIL_PROVIDER=resend
 *   RESEND_API_KEY=<key>
 *   EMAIL_FROM="HireOps <no-reply@notifications.example.com>"
 * The from-domain must be DKIM/SPF/DMARC-verified at Resend first.
 */

let cached: EmailProvider | null = null;

export function getEmailProvider(tenantId: string): EmailProvider {
  void tenantId;
  if (cached) return cached;
  cached = construct();
  return cached;
}

export function resetEmailProviderCache(): void {
  cached = null;
}

function construct(): EmailProvider {
  if (process.env.NODE_ENV === "test") return new LocalEmailProvider();
  const mode = process.env.EMAIL_PROVIDER ?? "local";
  if (mode === "local") return new LocalEmailProvider();
  if (mode === "resend") return constructResend();
  if (mode === "real") {
    // 'real' was the stub sentinel; the real provider is now 'resend'.
    throw new Error(
      "EMAIL_PROVIDER=real is no longer supported. Use EMAIL_PROVIDER=resend " +
        "(set RESEND_API_KEY and EMAIL_FROM).",
    );
  }
  throw new Error(`Unknown EMAIL_PROVIDER=${mode}. Supported: 'local' (default) | 'resend'.`);
}

function constructResend(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY to be set.");
  }
  const from = process.env.EMAIL_FROM;
  if (!from || from.trim() === "") {
    throw new Error(
      "EMAIL_PROVIDER=resend requires EMAIL_FROM to be set " +
        "(e.g. 'HireOps <no-reply@notifications.example.com>').",
    );
  }
  return new ResendEmailProvider({ apiKey, from });
}
