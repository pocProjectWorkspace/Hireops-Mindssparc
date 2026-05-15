import { createLogger, getSentryClient } from "@hireops/observability";
import type { Logger, SentryClient } from "@hireops/observability";

/**
 * Process-singleton logger + Sentry client for apps/api.
 *
 * Imported by both the entry point and the tenant-context middleware so
 * everyone references the same base instances. Per-request child loggers
 * (`baseLog.child({ request_id, tenant_id, actor_user_id })`) come out
 * of the middleware and are exposed on `c.var.log`.
 */
export const baseLog: Logger = createLogger({ base: { service: "apps/api" } });

export const sentry: SentryClient = getSentryClient(baseLog);

export type { Logger, SentryClient };
