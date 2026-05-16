import { LocalEmailProvider } from "./local";
import { RealEmailProviderStub } from "./real-stub";
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
  if (mode === "real") return new RealEmailProviderStub();
  throw new Error(
    `Unknown EMAIL_PROVIDER=${mode}. Supported: 'local' (default) | 'real' (stub).`,
  );
}
