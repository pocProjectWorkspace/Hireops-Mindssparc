import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Golden path:
 *   1. Visit /login (middleware permits — public path).
 *   2. Sign in with the seeded recruiter credentials.
 *   3. Land on /triage; verify the heading.
 *   4. Run axe; assert zero violations.
 *
 * Prerequisites:
 *   - apps/api and apps/internal-portal running (webServer block in
 *     playwright.config.ts boots them).
 *   - pnpm db:seed:test-users has been run at least once against the
 *     dev DB so recruiter1@kyndryl-poc.test exists.
 *
 * If the seeded user doesn't exist, the login step fails with a
 * Supabase 400 — the assertion below makes that case obvious in the
 * Playwright report.
 */

const TEST_EMAIL = "recruiter1@kyndryl-poc.test";
const TEST_PASSWORD = "TestPassword123!";

test("login → triage page is accessible", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.getByLabel("Email").fill(TEST_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(/\/triage/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: /triage/i })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    `axe violations: ${results.violations.map((v) => v.id).join(", ")}`,
  ).toEqual([]);
});
