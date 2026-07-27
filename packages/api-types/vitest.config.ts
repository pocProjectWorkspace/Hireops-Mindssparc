import { defineConfig } from "vitest/config";

/**
 * Vitest config for @hireops/api-types — pure unit tests, no DB, no network.
 *
 * The package's only runtime dependency is zod, and the tested helpers
 * (resolveAiBudget, projectMonthEndSpendMicros, deriveAiBudgetStatus,
 * crossedAiBudgetThresholds, …) are pure functions, so no env / setupFiles /
 * DATABASE_URL guard is needed. Mirrors @hireops/notifications's config, minus
 * the DB env.
 */
export default defineConfig({
  test: {
    globals: false,
    testTimeout: 5_000,
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
