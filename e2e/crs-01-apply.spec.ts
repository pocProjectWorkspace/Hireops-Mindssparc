import { test, expect, devices } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CRS-01 — public candidate apply flow.
 *
 * Two scopes:
 *   1. axe scan on the form page (mobile viewport)
 *   2. end-to-end: fill → upload → submit → confirmation
 *
 * Mobile viewport (Pixel 5: 393×851 chromium) so we exercise the layout
 * the apply form is designed for. The portal's golden-path spec stays
 * on desktop Chrome; this file overrides per-test. We use Pixel 5
 * because the project-level config only declares chromium — Apple
 * devices (iPhone *) would launch webkit and 404 on a fresh install.
 *
 * Prerequisites:
 *   - apps/api + apps/internal-portal running (webServer block boots them)
 *   - pnpm db:seed:demo-data           → seeds the kyndryl-poc tenant with
 *                                        one 'posted' requisition that has
 *                                        public_slug='gcc-blr-senior-backend'.
 *
 * Uses a real .docx fixture from the AI-02 corpus so the upload endpoint
 * (5 MB / PDF + DOCX only) actually accepts the file — the LocalAIClient
 * fixture hash matches this exact file, so parseResume returns a
 * deterministic result.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RESUME_FIXTURE = resolve(
  here,
  "../packages/ai-client/test/fixtures/resumes/Variant_1_Traditional_Single_Column.docx",
);

const TENANT_SLUG = "kyndryl-poc";
const REQ_SLUG = "gcc-blr-senior-backend";
const APPLY_PATH = `/t/${TENANT_SLUG}/apply/${REQ_SLUG}`;

test.use({ ...devices["Pixel 5"] });

test("public apply form passes axe (mobile)", async ({ page }) => {
  await page.goto(APPLY_PATH);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    `axe violations: ${results.violations.map((v) => v.id).join(", ")}`,
  ).toEqual([]);
});

test("candidate fills form, uploads resume, lands on confirmation", async ({ page }) => {
  // Capture network traffic for diagnostics if the test fails.
  const networkEvents: string[] = [];
  page.on("request", (req) => networkEvents.push(`> ${req.method()} ${req.url()}`));
  page.on("response", (res) => networkEvents.push(`< ${res.status()} ${res.url()}`));
  page.on("console", (msg) => networkEvents.push(`! ${msg.type()}: ${msg.text()}`));

  await page.goto(APPLY_PATH);

  // Wait for React hydration — the form sets data-hydrated="true" in a
  // useEffect after mount. Without this gate a fast Playwright click
  // beats hydration and the form does a native submit (querystring
  // GET) instead of calling our onSubmit handler.
  await page.locator('form[data-hydrated="true"]').waitFor({ state: "attached", timeout: 30_000 });

  // Unique email so re-running the test against the seeded DB doesn't
  // bump into the existing-application unique constraint — Persons
  // dedup is silent but the (tenant, candidate, req) unique on
  // applications would otherwise return the existing row instead of a
  // fresh one.
  const stamp = Date.now();
  const email = `crs01-e2e-${stamp}@hireops-dev.local`;
  const phone = `+918${String(stamp).slice(-9)}`;

  await page.getByLabel("Full name").fill("CRS-01 E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Phone").fill(phone);

  // Hidden native file input — set the file directly. Playwright's
  // setInputFiles handles the underlying file upload protocol.
  await page.locator("input[type=file]").setInputFiles(RESUME_FIXTURE);

  // Consent checkbox — the visible label is "I consent to ..."; click
  // the input by id since the long label has multiple text nodes.
  await page.locator("#consent").check();

  await page.getByRole("button", { name: /submit application/i }).click();

  // Server resolves + redirects to the submitted page.
  try {
    await page.waitForURL(/\/submitted\?ref=/, { timeout: 30_000 });
  } catch (e) {
    console.error("network/console trace:\n" + networkEvents.join("\n"));
    throw e;
  }
  await expect(
    page.getByRole("heading", { level: 1, name: /application received/i }),
  ).toBeVisible();
  await expect(page.getByText(/your reference/i)).toBeVisible();
});
