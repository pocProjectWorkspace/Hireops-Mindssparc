import type { Logger } from "pino";
import { LocalSentryClient } from "./local";
import { RealSentryClient } from "./real";
import type { SentryClient } from "./types";

export type {
  SentryBreadcrumb,
  SentryCaptureContext,
  SentryClient,
  SentryLevel,
  SentryUser,
} from "./types";
export { LocalSentryClient, RealSentryClient };

let cached: SentryClient | undefined;

/**
 * Returns the Sentry client configured for this process.
 *
 * Activated by SENTRY_DSN being set in the environment. With no DSN we
 * fall through to the LocalSentryClient, which logs every captured
 * payload through the supplied pino logger so dev mode stays useful
 * without requiring a Sentry account.
 *
 * Cached per-process — the first call wins, subsequent calls return
 * the same client. Tests that need a fresh client should construct
 * Local/Real clients directly.
 */
export function getSentryClient(log: Logger): SentryClient {
  if (cached) return cached;
  const dsn = process.env.SENTRY_DSN;
  if (dsn && dsn.length > 0) {
    cached = new RealSentryClient(dsn);
  } else {
    cached = new LocalSentryClient(log);
  }
  return cached;
}

/**
 * Reset the cached singleton. Test-only escape hatch — production code
 * should call getSentryClient() once at startup and reuse the instance.
 */
export function resetSentryClient(): void {
  cached = undefined;
}
