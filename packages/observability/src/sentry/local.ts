import type { Logger } from "pino";
import type {
  SentryBreadcrumb,
  SentryCaptureContext,
  SentryClient,
  SentryLevel,
  SentryUser,
} from "./types";

/**
 * Local-mode Sentry client. Every capture* call writes a structured
 * line through the supplied pino logger so devs see the same payload
 * they'd see in Sentry, without needing a Sentry account.
 *
 * Breadcrumbs accumulate in a small ring buffer and are attached to the
 * next captureException's payload, mirroring Sentry's own behaviour.
 * setUser / setTag mutate the per-instance context applied to every
 * subsequent capture.
 *
 * Cap the breadcrumb buffer at 50 entries — same default Sentry uses —
 * so a long-lived process doesn't accumulate unbounded memory.
 */
const BREADCRUMB_LIMIT = 50;

export class LocalSentryClient implements SentryClient {
  private readonly log: Logger;
  private breadcrumbs: SentryBreadcrumb[] = [];
  private user: SentryUser | null = null;
  private tags: Record<string, string> = {};

  constructor(log: Logger) {
    this.log = log.child({ component: "sentry-local" });
  }

  captureException(err: unknown, context?: SentryCaptureContext): void {
    const merged = this.mergeContext(context);
    const payload = {
      err,
      breadcrumbs: this.breadcrumbs,
      ...merged,
      sentry: { event: "captureException" },
    };
    const level = merged.level ?? "error";
    this.emit(level, payload, "sentry.captureException");
    this.breadcrumbs = [];
  }

  captureMessage(
    message: string,
    level: SentryLevel = "info",
    context?: SentryCaptureContext,
  ): void {
    const merged = this.mergeContext(context);
    const payload = {
      message,
      breadcrumbs: this.breadcrumbs,
      ...merged,
      sentry: { event: "captureMessage", level },
    };
    this.emit(merged.level ?? level, payload, message);
  }

  addBreadcrumb(breadcrumb: SentryBreadcrumb): void {
    this.breadcrumbs.push({ timestamp: Date.now() / 1000, level: "info", ...breadcrumb });
    if (this.breadcrumbs.length > BREADCRUMB_LIMIT) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - BREADCRUMB_LIMIT);
    }
  }

  setUser(user: SentryUser | null): void {
    this.user = user;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  async flush(): Promise<boolean> {
    // Local client logs synchronously through pino; nothing to flush.
    return true;
  }

  private mergeContext(context?: SentryCaptureContext): SentryCaptureContext {
    return {
      tags: { ...this.tags, ...(context?.tags ?? {}) },
      extra: { ...(context?.extra ?? {}) },
      level: context?.level,
      user: context?.user ?? this.user ?? undefined,
    };
  }

  private emit(level: SentryLevel, payload: Record<string, unknown>, message: string): void {
    switch (level) {
      case "fatal":
        this.log.fatal(payload, message);
        return;
      case "error":
        this.log.error(payload, message);
        return;
      case "warning":
        this.log.warn(payload, message);
        return;
      case "debug":
        this.log.debug(payload, message);
        return;
      case "info":
      default:
        this.log.info(payload, message);
    }
  }
}
