// Deep import bypasses @hireops/db's main entry which side-effects on
// DATABASE_URL at module load via client.ts. The bridge is pure (no DB)
// so we don't want that runtime dep — it would break pure-function
// tests in this package. Schema source-of-truth still lives in
// packages/db/src/zod/agent-configs.ts.
import {
  ActionConfigSchema,
  type ActionConfig,
} from "@hireops/db/src/zod/agent-configs";

/**
 * Bridge DB-column `action_type` to the Zod schema discriminator `type`.
 *
 * agent_actions stores the discriminator on the table column
 * (`action_type` text + CHECK constraint), not inside the jsonb config.
 * The Zod ActionConfigSchema discriminates on `type` inside the parsed
 * object — its members each carry `type: z.literal(...)`.
 *
 * Convention: writers (createFollowUpAgent, future agent CRUD) store
 * the jsonb WITHOUT a `type` field. The column is the source of truth
 * for the discriminator, and this helper reunites them at read time.
 *
 * Failure modes:
 *   - z.ZodError on unknown / extra fields, missing fields, wrong types
 *   - ActionConfigMismatchError (downstream, from the executor) when the
 *     dispatch table somehow hands the row to the wrong executor —
 *     defensive only; the DB CHECK + the registry's exhaustive typing
 *     make it unreachable in practice.
 *
 * Both classes of failure are TERMINAL for the worker (no retry — data
 * won't fix itself). Same shape as AI-03's ZodError-terminal pattern.
 */
export function bridgeActionConfig(
  actionType: string,
  actionConfig: Record<string, unknown>,
): ActionConfig {
  return ActionConfigSchema.parse({ type: actionType, ...actionConfig });
}
