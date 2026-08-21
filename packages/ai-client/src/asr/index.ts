import { AssemblyAIASRClient } from "./assemblyai";
import { DeepgramASRClient } from "./deepgram";
import { LocalASRClient } from "./local";
import type { ASRClient } from "./types";

/**
 * ASR client resolution.
 *
 * Selection, mirroring getStorageClient() / getAIClient():
 *   - NODE_ENV=test         → LocalASRClient (CI never calls a vendor, never
 *                             burns a minute, and needs no key)
 *   - ASR_CLIENT_MODE=local → LocalASRClient (dev convenience; deliberately
 *                             a separate switch from AI_CLIENT_MODE, because
 *                             "real LLM, fake audio" is a combination you
 *                             actually want while building N3.3)
 *   - ASR_PROVIDER=deepgram → DeepgramASRClient, requiring DEEPGRAM_API_KEY
 *   - default               → AssemblyAIASRClient, requiring
 *                             ASSEMBLYAI_API_KEY
 *
 * The local tier keeps its precedence: NODE_ENV=test / ASR_CLIENT_MODE=local
 * win over ASR_PROVIDER, so no test can be talked into calling a vendor by
 * an env var left in a shell.
 *
 * AssemblyAI is the default because the client chose it (N3.1b). Deepgram
 * stays one env var away rather than deleted: the vendor decision is
 * reversible, and keeping two live implementations behind ASRClient is the
 * only thing that actually demonstrates the interface is provider-agnostic.
 *
 * TENANT-BOUND, LIKE getAIClient AND UNLIKE getStorageClient. The API key
 * is platform-level (see deepgram.ts on why ASR is not BYO), but every call
 * writes a per-tenant ai_usage_logs row, so the client has to know whose
 * minutes it is spending. Passing the tenant per-call instead would make it
 * possible to forget, and a missing cost row on the platform's only
 * non-token COGS line is the failure this ticket exists to prevent.
 *
 * Cached per tenant with NO TTL, which is where this differs from
 * getAIClient's five minutes. That TTL exists because the AI factory caches
 * a *decrypted per-tenant credential* that can be rotated in the database.
 * Nothing here decrypts anything: the key comes from the environment and
 * rotating it means restarting the process anyway — the same reasoning that
 * makes getStorageClient a plain per-process singleton. resetASRClient() is
 * the test escape hatch.
 */

const cache = new Map<string, ASRClient>();

type ASRMode = "local" | "assemblyai" | "deepgram";

export function getASRClient(tenantId: string): ASRClient {
  const mode = resolveMode();
  const key = `${tenantId}::${mode}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let client: ASRClient;
  if (mode === "local") {
    client = new LocalASRClient({ tenantId });
  } else if (mode === "deepgram") {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DeepgramASRClient requires DEEPGRAM_API_KEY. " +
          "Set ASR_CLIENT_MODE=local for dev without an ASR vendor.",
      );
    }
    client = new DeepgramASRClient({ tenantId, apiKey });
  } else {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "AssemblyAIASRClient requires ASSEMBLYAI_API_KEY. " +
          "Set ASR_CLIENT_MODE=local for dev without an ASR vendor, " +
          "or ASR_PROVIDER=deepgram to use Deepgram instead.",
      );
    }
    client = new AssemblyAIASRClient({ tenantId, apiKey });
  }
  cache.set(key, client);
  return client;
}

export function resetASRClient(): void {
  cache.clear();
}

/**
 * Local tier first — see the header on why it outranks ASR_PROVIDER. An
 * unrecognised ASR_PROVIDER throws rather than silently falling back to the
 * default: a typo'd vendor name that quietly bills the other vendor is a
 * worse outcome than a process that refuses to start.
 */
function resolveMode(): ASRMode {
  if (process.env.NODE_ENV === "test" || process.env.ASR_CLIENT_MODE === "local") return "local";
  const provider = process.env.ASR_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "assemblyai") return "assemblyai";
  if (provider === "deepgram") return "deepgram";
  throw new Error(
    `Unknown ASR_PROVIDER "${provider}". Expected "assemblyai" (default) or "deepgram"; ` +
      "set ASR_CLIENT_MODE=local for dev without an ASR vendor.",
  );
}

export { LocalASRClient, hashTranscribeInput, LOCAL_ASR_MODEL } from "./local";
export type { LocalASRClientOpts } from "./local";
export { DeepgramASRClient, DEFAULT_DEEPGRAM_MODEL } from "./deepgram";
export type { DeepgramASRClientOpts } from "./deepgram";
export {
  AssemblyAIASRClient,
  DEFAULT_ASSEMBLYAI_MODEL,
  ASSEMBLYAI_US_BASE_URL,
  ASSEMBLYAI_EU_BASE_URL,
  resolveAssemblyAIBaseUrl,
} from "./assemblyai";
export type { AssemblyAIASRClientOpts } from "./assemblyai";
export { ASRError, ASRUnsupportedMediaError } from "./types";
export type { ASRClient, ASRProvider, ASRResult, ASRSegment, ASRTranscribeOptions } from "./types";
