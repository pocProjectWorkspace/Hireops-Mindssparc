import { defineConfig } from "vitest/config";

/**
 * Vitest config for @hireops/notifications — unit tests, no DB, no network.
 * Mirrors @hireops/agent-actions's config.
 *
 * The factory transitively imports @hireops/db, whose client module throws
 * at import time if DATABASE_URL is unset. These tests never open a
 * connection (LocalEmailProvider is constructed but never sent; the Resend
 * path is fully fetch-mocked), so a dummy DATABASE_URL satisfies that guard
 * while keeping the suite DB-free and pooler-immune. postgres-js connects
 * lazily, so the URL is never dialled.
 */
export default defineConfig({
  test: {
    globals: false,
    testTimeout: 5_000,
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
    env: {
      DATABASE_URL:
        "postgresql://vitest:vitest@127.0.0.1:5432/hireops_notifications_test",
    },
  },
});
