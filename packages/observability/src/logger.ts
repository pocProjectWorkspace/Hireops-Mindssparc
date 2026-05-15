import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger };

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface CreateLoggerOpts {
  /** Override the level. Defaults to LOG_LEVEL env var, then 'info'. */
  level?: LogLevel;
  /**
   * Force pretty-printing on/off. Defaults to dev (NODE_ENV !== 'production'
   * AND NODE_ENV !== 'test'). In tests we keep JSON to avoid the
   * pino-pretty worker spinning up per test process.
   */
  pretty?: boolean;
  /** Static fields included on every log line (e.g. service, version). */
  base?: Record<string, unknown>;
}

/**
 * Returns a configured pino logger.
 *
 * Output format:
 *   - production / test: JSON (one object per line) to stdout. Suitable
 *     for `jq`, log aggregators, and CI grepping.
 *   - dev (default): pretty-printed via the pino-pretty transport.
 *
 * Pino's transport-based pretty printing spins up a worker thread; we
 * skip it in test mode so the test runner doesn't have to wait for the
 * worker to boot or drain.
 */
export function createLogger(opts: CreateLoggerOpts = {}): Logger {
  const level = opts.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
  const isTest = process.env.NODE_ENV === "test";
  const isProd = process.env.NODE_ENV === "production";
  const pretty = opts.pretty ?? (!isProd && !isTest);

  const options: LoggerOptions = { level, base: opts.base };
  if (pretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    };
  }
  return pino(options);
}
