import { defineConfig } from "vitest/config";

/**
 * Vitest config for @hireops/ai-scoring — pure-function tests, no DB.
 * Default forks pool + no fileParallelism cap needed; the test suite
 * is dependency-free and finishes in milliseconds.
 */
export default defineConfig({
  test: {
    globals: false,
    testTimeout: 5_000,
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
