import { defineConfig, devices } from "@playwright/test";

/**
 * Repo-root Playwright config — E2E tests at /e2e exercise the
 * internal-portal end-to-end (login → /triage → axe). The webServer
 * block boots `pnpm dev` (turbo orchestrates api + portal in
 * parallel) before tests, and tears it down after.
 *
 * If CI starts spending too long here, pre-start the dev servers in a
 * separate CI step and remove the webServer block — the tests
 * themselves are framework-agnostic about how the server got up.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000/login",
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
      },
});
