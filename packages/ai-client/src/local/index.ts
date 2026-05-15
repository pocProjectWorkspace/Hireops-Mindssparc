import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordAIUsage } from "../usage-log";
import { hashCompleteOptions, hashStructuredOptions } from "./hash";
import type {
  AIClient,
  AICompleteOptions,
  AICompleteResult,
  AIStructuredCompleteOptions,
} from "../types";

/**
 * Fixture-based AI client for dev / test.
 *
 * Every call hashes (prompt + system + model [+ schema]) to a sha256
 * hex key and looks up `fixtures/<hash>.json`. If no fixture exists, we
 * throw a clear error pointing at the path to create. This keeps tests
 * explicit about what they're testing against — no accidental "the
 * model returned something reasonable" behaviour.
 *
 * Fixture format:
 *   {
 *     "text": "...",                // for complete()
 *     "json": { ... },              // for completeStructured() — alt to "text"
 *     "inputTokens": 100,
 *     "outputTokens": 50,
 *     "costMicros": 300,            // 1 USD = 1,000,000 micros
 *     "latencyMs": 42,              // optional; defaults to actual elapsed
 *     "throw": { "message": "rate limited", "code": "rate_limit" }  // optional
 *   }
 *
 * If `throw` is set, the call rejects with that error AND writes an
 * ai_usage_logs row with succeeded=false + error_code populated. This
 * lets tests exercise the failure path of the cost-logging contract.
 *
 * Token counts and cost come from the fixture so the logging path is
 * exercised end-to-end (the test asserts on the recorded row). LocalAIClient
 * doesn't try to estimate cost.
 */

interface FixtureEnvelope {
  text?: string;
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | string;
  latencyMs?: number;
  throw?: { message: string; code?: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = resolve(here, "./fixtures");

export interface LocalAIClientOpts {
  tenantId: string;
  /**
   * Directory containing fixture JSON files. Defaults to the
   * package's bundled `fixtures/` directory. Override for tests that
   * want to ship their own fixtures alongside the test file.
   */
  fixtureDir?: string;
}

export class LocalAIClient implements AIClient {
  readonly provider = "local" as const;
  private readonly tenantId: string;
  private readonly fixtureDir: string;

  constructor(opts: LocalAIClientOpts) {
    this.tenantId = opts.tenantId;
    this.fixtureDir = opts.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  }

  async complete(opts: AICompleteOptions): Promise<AICompleteResult> {
    const start = Date.now();
    const hash = hashCompleteOptions(opts);
    const fixture = await this.loadFixture(hash);
    const text = fixture.text;
    if (text === undefined) {
      await this.writeLogFailure(opts, "local", "missing_text_field", Date.now() - start);
      throw new Error(
        `LocalAIClient fixture ${hash}.json is missing the "text" field (required for complete()).`,
      );
    }
    return this.completeFromFixture(opts, fixture, text, start);
  }

  async completeStructured<T>(opts: AIStructuredCompleteOptions<T>): Promise<T> {
    const start = Date.now();
    const hash = hashStructuredOptions(opts);
    const fixture = await this.loadFixture(hash);
    if (fixture.throw) {
      await this.writeLogFailure(
        opts,
        opts.model ?? "local",
        fixture.throw.code ?? "fixture_error",
        Date.now() - start,
        fixture,
      );
      const e = new Error(fixture.throw.message) as Error & { code?: string };
      if (fixture.throw.code) e.code = fixture.throw.code;
      throw e;
    }
    const value = fixture.json;
    if (value === undefined) {
      await this.writeLogFailure(
        opts,
        opts.model ?? "local",
        "missing_json_field",
        Date.now() - start,
      );
      throw new Error(
        `LocalAIClient fixture ${hash}.json is missing the "json" field (required for completeStructured()).`,
      );
    }
    const latencyMs = fixture.latencyMs ?? Date.now() - start;
    await recordAIUsage({
      tenantId: this.tenantId,
      provider: this.provider,
      model: opts.model ?? "local",
      feature: opts.feature,
      actorMembershipId: opts.actorMembershipId ?? null,
      inputTokens: fixture.inputTokens,
      outputTokens: fixture.outputTokens,
      costMicros: BigInt(fixture.costMicros),
      latencyMs,
      requestId: opts.requestId ?? null,
      succeeded: true,
    });
    return value as T;
  }

  private async completeFromFixture(
    opts: AICompleteOptions,
    fixture: FixtureEnvelope,
    text: string,
    start: number,
  ): Promise<AICompleteResult> {
    if (fixture.throw) {
      await this.writeLogFailure(
        opts,
        opts.model ?? "local",
        fixture.throw.code ?? "fixture_error",
        Date.now() - start,
        fixture,
      );
      const e = new Error(fixture.throw.message) as Error & { code?: string };
      if (fixture.throw.code) e.code = fixture.throw.code;
      throw e;
    }
    const latencyMs = fixture.latencyMs ?? Date.now() - start;
    const model = opts.model ?? "local";
    await recordAIUsage({
      tenantId: this.tenantId,
      provider: this.provider,
      model,
      feature: opts.feature,
      actorMembershipId: opts.actorMembershipId ?? null,
      inputTokens: fixture.inputTokens,
      outputTokens: fixture.outputTokens,
      costMicros: BigInt(fixture.costMicros),
      latencyMs,
      requestId: opts.requestId ?? null,
      succeeded: true,
    });
    return {
      text,
      model,
      inputTokens: fixture.inputTokens,
      outputTokens: fixture.outputTokens,
      costMicros: BigInt(fixture.costMicros),
      latencyMs,
    };
  }

  private async loadFixture(hash: string): Promise<FixtureEnvelope> {
    const path = resolve(this.fixtureDir, `${hash}.json`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(
        `LocalAIClient: no fixture for prompt hash ${hash}. ` +
          `Add ${path} or use a real provider. ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return JSON.parse(raw) as FixtureEnvelope;
  }

  private async writeLogFailure(
    opts: AICompleteOptions,
    model: string,
    errorCode: string,
    latencyMs: number,
    fixture?: FixtureEnvelope,
  ): Promise<void> {
    await recordAIUsage({
      tenantId: this.tenantId,
      provider: this.provider,
      model,
      feature: opts.feature,
      actorMembershipId: opts.actorMembershipId ?? null,
      inputTokens: fixture?.inputTokens ?? 0,
      outputTokens: fixture?.outputTokens ?? 0,
      costMicros: BigInt(fixture?.costMicros ?? 0),
      latencyMs,
      requestId: opts.requestId ?? null,
      succeeded: false,
      errorCode,
    });
  }
}
