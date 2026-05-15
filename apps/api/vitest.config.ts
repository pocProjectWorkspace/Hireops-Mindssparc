import { defineConfig } from "vitest/config";

/**
 * Vitest config for apps/api integration tests.
 *
 * The two test files in test/ exercise a real Supabase dev DB through
 * postgres-js. The chained-tsx runner we used previously was brittle
 * because connections lingered on the Supabase pooler between files.
 * Vitest solves this for us:
 *
 *   - pool: 'forks' — each test file runs in its own forked Node process.
 *     Different processes get different postgres-js pools, so files don't
 *     share connections at all.
 *   - fileParallelism: false — files run one at a time, never concurrently.
 *     Both files hit the same DB; serialising avoids fixture interference.
 *   - testTimeout: 30s — DB round-trips + JWT auth on first request can be
 *     slow against Supabase from a residential network.
 *   - hookTimeout: 30s — beforeAll does the JWT sign-in plus a fixture wipe.
 *
 * Globals are kept off (explicit imports). dotenv is loaded by each test
 * file via its `import "../src/bootstrap"` first line, so we don't need a
 * setupFiles entry here.
 */
export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
