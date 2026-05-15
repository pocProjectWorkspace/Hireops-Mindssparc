/**
 * Pluggable Sentry client interface.
 *
 * Mirrors the minimal subset of @sentry/node's API surface that apps/api
 * actually uses today. Keeping the shape close to Sentry's own means
 * swapping LocalSentryClient ↔ RealSentryClient is a config change, not
 * a refactor.
 *
 * Two implementations:
 *   - LocalSentryClient: logs every capture* call to the pino logger.
 *     Breadcrumbs accumulate in memory and attach to the next exception.
 *     flush() is a no-op. Default in dev / test / when SENTRY_DSN unset.
 *   - RealSentryClient: thin wrapper over @sentry/node. Activated by
 *     SENTRY_DSN being set in the environment.
 */

export type SentryLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface SentryUser {
  /** Stable user identifier. We use the public.users.id (= auth.users.id). */
  id?: string;
  email?: string;
  username?: string;
  [key: string]: unknown;
}

export interface SentryBreadcrumb {
  /** Human-readable message describing the breadcrumb. */
  message?: string;
  /** Category bucket — e.g. 'http', 'db', 'auth'. */
  category?: string;
  /** Severity level. Defaults to 'info'. */
  level?: SentryLevel;
  /** Free-form extra data. */
  data?: Record<string, unknown>;
  /** Unix epoch seconds. Defaults to now() when omitted. */
  timestamp?: number;
}

export interface SentryCaptureContext {
  /** Tags get indexed for filtering (e.g. tenant_id, request_id). */
  tags?: Record<string, string>;
  /** Extra context, not indexed. */
  extra?: Record<string, unknown>;
  /** Override severity for this capture. */
  level?: SentryLevel;
  /** Optional user override for this capture. */
  user?: SentryUser;
}

export interface SentryClient {
  /** Capture an exception with optional structured context. */
  captureException(err: unknown, context?: SentryCaptureContext): void;
  /** Capture a free-form message at the given level. */
  captureMessage(message: string, level?: SentryLevel, context?: SentryCaptureContext): void;
  /** Add a breadcrumb that attaches to the next captured exception. */
  addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
  /** Set the current user for subsequent captures. Pass null to clear. */
  setUser(user: SentryUser | null): void;
  /** Set a tag for subsequent captures. */
  setTag(key: string, value: string): void;
  /**
   * Flush any pending events. RealSentryClient awaits the upstream send;
   * LocalSentryClient is a no-op (it logged synchronously).
   */
  flush(timeoutMs?: number): Promise<boolean>;
}
