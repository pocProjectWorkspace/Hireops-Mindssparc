/**
 * @hireops/api-types
 *
 * Zod schemas + TypeScript types for the tRPC API surface, shared with
 * the frontend so apps/internal-portal and friends don't reach into
 * apps/api. The AppRouter *type* lives in apps/api and is consumed via
 * `import type { AppRouter } from '@hireops/api/trpc'` (type-only,
 * erased at bundle time).
 */

export * from "./enums";
export * from "./procedures";
export * from "./jd-quality";
export * from "./ai-settings";
export * from "./bias-lexicon";
export * from "./scoring-weights";
export * from "./governance";
export * from "./market-intelligence";
export * from "./comp";
export * from "./panel-prep";
export * from "./req-revision";
export * from "./requirement-owner";
export * from "./recruiter";
