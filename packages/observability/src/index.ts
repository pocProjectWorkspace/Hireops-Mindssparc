// Public surface of @hireops/observability.
//
// Logger: pino-based structured logger via createLogger(). Use child
// loggers (`log.child({ tenant_id, request_id })`) to attach per-request
// context.
//
// Sentry: SentryClient interface with Local + Real implementations.
// getSentryClient(log) returns the Real client when SENTRY_DSN is set,
// the Local client (which logs through pino) otherwise. Local mode is
// fully functional in dev — captureException payloads land in stdout
// JSON ready for `jq`.

export { createLogger } from "./logger";
export type { Logger, LogLevel, CreateLoggerOpts } from "./logger";

export { LocalSentryClient, RealSentryClient, getSentryClient, resetSentryClient } from "./sentry";
export type {
  SentryBreadcrumb,
  SentryCaptureContext,
  SentryClient,
  SentryLevel,
  SentryUser,
} from "./sentry";
