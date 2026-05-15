import { createRequire } from "node:module";
import type {
  SentryBreadcrumb,
  SentryCaptureContext,
  SentryClient,
  SentryLevel,
  SentryUser,
} from "./types";

/**
 * Wraps @sentry/node behind our SentryClient interface.
 *
 * @sentry/node is an optional peer dep — apps that don't enable Sentry
 * should never have to install it. We resolve it via createRequire from
 * the constructor so:
 *   - Loading this module is free when SENTRY_DSN is unset (the Local
 *     client gets selected, this class is never constructed).
 *   - The dep is only required at the moment we know we need it. If it's
 *     missing the throw is loud and tells you what to install.
 *
 * The shape mirrors @sentry/node's global hub. Multi-process deployments
 * that need separate Sentry contexts can rework this to use
 * Sentry.getClient() / Scopes; today we delegate to the global hub.
 */

interface SentryNodeModule {
  init(opts: { dsn: string; tracesSampleRate?: number; environment?: string }): void;
  captureException(err: unknown, ctx?: SentryCaptureContext): void;
  captureMessage(message: string, ctx?: SentryCaptureContext & { level?: SentryLevel }): void;
  addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
  setUser(user: SentryUser | null): void;
  setTag(key: string, value: string): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

const requireFromHere = createRequire(import.meta.url);

function loadSentry(): SentryNodeModule {
  try {
    return requireFromHere("@sentry/node") as SentryNodeModule;
  } catch (err) {
    throw new Error(
      "@sentry/node is not installed. Install it (`pnpm add @sentry/node`) " +
        "in the consuming app to enable RealSentryClient, or unset SENTRY_DSN " +
        "to fall back to LocalSentryClient. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class RealSentryClient implements SentryClient {
  private readonly Sentry: SentryNodeModule;

  constructor(dsn: string) {
    if (!dsn) {
      throw new Error("RealSentryClient requires a non-empty DSN.");
    }
    this.Sentry = loadSentry();
    this.Sentry.init({
      dsn,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      environment: process.env.NODE_ENV ?? "development",
    });
  }

  captureException(err: unknown, context?: SentryCaptureContext): void {
    this.Sentry.captureException(err, context);
  }

  captureMessage(
    message: string,
    level: SentryLevel = "info",
    context?: SentryCaptureContext,
  ): void {
    this.Sentry.captureMessage(message, { ...context, level: context?.level ?? level });
  }

  addBreadcrumb(breadcrumb: SentryBreadcrumb): void {
    this.Sentry.addBreadcrumb(breadcrumb);
  }

  setUser(user: SentryUser | null): void {
    this.Sentry.setUser(user);
  }

  setTag(key: string, value: string): void {
    this.Sentry.setTag(key, value);
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    return this.Sentry.flush(timeoutMs);
  }
}
