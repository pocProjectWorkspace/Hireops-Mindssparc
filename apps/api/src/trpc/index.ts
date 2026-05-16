/**
 * Side-effect-free entry for cross-workspace consumers (notably
 * apps/internal-portal's server-side tRPC caller). Importing
 * apps/api/src/index.ts would also start the Hono `serve()` listener
 * since Next.js doesn't set NODE_ENV=test; this entry just re-exports
 * the router so the caller-only code path stays clean.
 */

export { appRouter, type AppRouter } from "./router";
export type { HonoTRPCContext } from "./trpc-core";
