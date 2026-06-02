import { defineConfig } from "vitest/config";

/**
 * Vitest config for @hireops/agent-actions — pure-function tests, no DB.
 * Mirrors @hireops/ai-scoring's config; the executor stubs are
 * dependency-free and finish in milliseconds.
 */
export default defineConfig({
  test: {
    globals: false,
    testTimeout: 5_000,
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
