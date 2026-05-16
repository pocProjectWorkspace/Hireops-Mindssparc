import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Two-scope E2E:
 *
 *   1. login → /triage → axe (Module 1a baseline)
 *   2. drawer-open flow: click a seeded candidate, drawer opens,
 *      Esc closes the drawer, URL returns to /triage without
 *      `?candidateId=`. Module 1b adds this scope.
 *
 * The Advance / Reject + UndoToast click flow is left to manual QA
 * for Wave 1 — wiring it deterministically here needs careful waiting
 * on the tRPC mutation round-trip + cache invalidation, which is
 * fragile under the webServer-pnpm-dev cold start. Documented in
 * HANDOVER; revisit when dev-server cold start gets cheaper.
 *
 * Prerequisites:
 *   - apps/api + apps/internal-portal running (webServer block boots them)
 *   - pnpm db:seed:test-users          → recruiter1@kyndryl-poc.test
 *   - pnpm db:seed:demo-candidates     → 3 demo applications visible
 */

const TEST_EMAIL = "recruiter1@kyndryl-poc.test";
const TEST_PASSWORD = "TestPassword123!";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(TEST_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/triage/, { timeout: 30_000 });
}

test("login → triage page is accessible", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: /triage/i })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    `axe violations: ${results.violations.map((v) => v.id).join(", ")}`,
  ).toEqual([]);
});

test("clicking a candidate opens the drawer; Esc closes", async ({ page }) => {
  await signIn(page);

  // Cards render as <button>s containing the candidate's email. Match
  // any seeded demo email; if none are present skip the scope.
  const firstCard = page
    .locator("button")
    .filter({ hasText: /@example\.com/ })
    .first();
  const cardCount = await firstCard.count();
  test.skip(cardCount === 0, "no demo candidates visible — run `pnpm db:seed:demo-candidates`");

  await firstCard.click();

  const drawer = page.getByRole("dialog", { name: /candidate detail/i });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/candidateId=/);

  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(page).not.toHaveURL(/candidateId=/);
});
