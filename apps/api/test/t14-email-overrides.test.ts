/**
 * T1.4 / G09 — email/notification copy overrides (tenant_email_template_overrides).
 *
 * Makes real the "no tenant can change any email copy" gap: an admin overrides
 * the SUBJECT + NAMED TEXT SLOTS of the 12 code-owned transactional templates,
 * while layout/styles/data bindings stay fixed (no raw-HTML editor). Exercised
 * over real cloud-minted JWTs (reality #110 — sign in as the seeded personas):
 *
 *   Test 1: upsertEmailTemplateOverride (admin) writes subject + slot overrides;
 *           getEmailTemplateCatalog (admin) reflects them (enabled, stored copy).
 *   Test 2: gating — recruiter is FORBIDDEN on the catalog read, the upsert, AND
 *           the preview (admin-only config).
 *   Test 3: honesty gate — an unknown slotKey, an unknown token, and a subject
 *           override on a caller-composed-subject template are all rejected.
 *   Test 4: FALLBACK is byte-identical — previewEmailTemplate with no overrides
 *           equals the code-owned renderTemplate() default (subject + html).
 *   Test 5: overrides applied — token interpolation in the subject AND in a slot;
 *           previewEmailTemplate output is byte-identical to the resolved
 *           renderTemplate(key, sample, overrides).
 *   Test 6: resetEmailTemplateOverride (admin) deletes the row → catalog override
 *           back to null (default copy).
 *   Test 7: tenant isolation — another tenant's override row never appears in the
 *           kyndryl-poc admin's catalog / list.
 *
 * Uses candidate.stage_advanced (NOT seeded by seed-t14-email-overrides, which
 * seeds application_received + interview_invitation) so the suite never clobbers
 * seed data. Cleans up its own rows in afterAll.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { renderTemplate, EMAIL_TEMPLATE_SAMPLE_DATA } from "@hireops/email-templates";
import type { TemplateKey } from "@hireops/notifications";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

// A second, unrelated tenant seeded in the shared DB — used only to prove
// isolation. We insert + remove one row under it.
const OTHER_TENANT_ID = "00000000-0000-4000-8000-00000a02e001";

// The template this suite owns. NOT seeded by seed-t14-email-overrides (disjoint).
const TEST_TEMPLATE: TemplateKey = "candidate.stage_advanced";
// A caller-composed-subject template (subject is not overridable).
const NO_SUBJECT_TEMPLATE = "recruiter.sla_ops_alert";

let recruiterJwt: string;
let adminJwt: string;
let tenantId: string;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface OverrideRow {
  templateKey: string;
  subjectOverride: string | null;
  slotOverrides: Record<string, string>;
  enabled: boolean;
  hasOverride: boolean;
}
interface CatalogEntry {
  templateKey: string;
  label: string;
  subject: { defaultText: string; tokens: string[] } | null;
  slots: { slotKey: string; tokens: string[] }[];
  override: OverrideRow | null;
}
interface CatalogOut {
  templates: CatalogEntry[];
}
interface PreviewOut {
  subject: string;
  html: string;
}

function entry(cat: CatalogOut, key: string): CatalogEntry {
  const e = cat.templates.find((t) => t.templateKey === key);
  assert.ok(e, `catalog has ${key}`);
  return e!;
}

describe("T1.4 / G09 email/notification copy overrides", () => {
  beforeAll(async () => {
    [recruiterJwt, adminJwt] = await Promise.all([signIn(RECRUITER), signIn(ADMIN)]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    // A synthetic second tenant for the isolation probe (Test 7). The FK to
    // tenants is enforced, so the probe row needs a real tenant to hang off;
    // create one idempotently and tear it down in afterAll.
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${OTHER_TENANT_ID}, 't14-isolation-probe', 'T14 Isolation Probe',
              'ap-northeast-1', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    // Start clean for the disjoint test template.
    await poolSql`
      DELETE FROM public.tenant_email_template_overrides
      WHERE tenant_id = ${tenantId} AND template_key = ${TEST_TEMPLATE}
    `;
  });

  afterAll(async () => {
    try {
      await poolSql`
        DELETE FROM public.tenant_email_template_overrides
        WHERE tenant_id = ${tenantId} AND template_key = ${TEST_TEMPLATE}
      `;
      // Deleting the probe tenant cascades its override row (FK ON DELETE cascade).
      await poolSql`DELETE FROM public.tenants WHERE id = ${OTHER_TENANT_ID}`;
    } catch {
      // best-effort — leave residue for the groom sweep rather than fail.
    }
  });

  it("Test 1: upsertEmailTemplateOverride (admin) + getEmailTemplateCatalog round-trip", async () => {
    const up = await trpcMutation<{ row: OverrideRow }>(
      "upsertEmailTemplateOverride",
      {
        templateKey: TEST_TEMPLATE,
        subjectOverride: "Your {positionTitle} application — an update",
        slotOverrides: { greeting: "Dear {candidateName}," },
        enabled: true,
      },
      adminJwt,
    );
    assert.ok(!isErr(up), `upsert: ${JSON.stringify(up)}`);
    assert.equal(
      up.result.data.row.subjectOverride,
      "Your {positionTitle} application — an update",
    );
    assert.equal(up.result.data.row.slotOverrides.greeting, "Dear {candidateName},");
    assert.equal(up.result.data.row.enabled, true);

    const cat = await trpcQuery<CatalogOut>("getEmailTemplateCatalog", {}, adminJwt);
    assert.ok(!isErr(cat), `catalog: ${JSON.stringify(cat)}`);
    const e = entry(cat.result.data, TEST_TEMPLATE);
    assert.ok(e.override, "override present in catalog");
    assert.equal(e.override!.enabled, true);
    assert.equal(e.override!.slotOverrides.greeting, "Dear {candidateName},");
    // Idempotent update — relabel subject, still exactly one row.
    const up2 = await trpcMutation(
      "upsertEmailTemplateOverride",
      {
        templateKey: TEST_TEMPLATE,
        subjectOverride: null,
        slotOverrides: { greeting: "Hello {candidateName}!" },
        enabled: false,
      },
      adminJwt,
    );
    assert.ok(!isErr(up2), `upsert2: ${JSON.stringify(up2)}`);
    const [{ n } = { n: 0 }] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_email_template_overrides
      WHERE tenant_id = ${tenantId} AND template_key = ${TEST_TEMPLATE}
    `;
    assert.equal(Number(n), 1, "still exactly one row (upsert replaced)");
  });

  it("Test 2: gating — recruiter FORBIDDEN on catalog read, upsert, and preview", async () => {
    const read = await trpcQuery("getEmailTemplateCatalog", {}, recruiterJwt);
    assert.ok(
      isErr(read) && read.error.data.code === "FORBIDDEN",
      "recruiter cannot read the catalog",
    );
    const write = await trpcMutation(
      "upsertEmailTemplateOverride",
      { templateKey: TEST_TEMPLATE, subjectOverride: "hacked", slotOverrides: {}, enabled: true },
      recruiterJwt,
    );
    assert.ok(
      isErr(write) && write.error.data.code === "FORBIDDEN",
      "recruiter cannot upsert an override",
    );
    const prev = await trpcQuery(
      "previewEmailTemplate",
      { templateKey: TEST_TEMPLATE },
      recruiterJwt,
    );
    assert.ok(isErr(prev) && prev.error.data.code === "FORBIDDEN", "recruiter cannot preview");
  });

  it("Test 3: honesty gate — unknown slot, unknown token, non-overridable subject rejected", async () => {
    const badSlot = await trpcMutation(
      "upsertEmailTemplateOverride",
      {
        templateKey: TEST_TEMPLATE,
        subjectOverride: null,
        slotOverrides: { notARealSlot: "x" },
        enabled: true,
      },
      adminJwt,
    );
    assert.ok(
      isErr(badSlot) && badSlot.error.data.code === "BAD_REQUEST",
      `unknown slotKey rejected: ${JSON.stringify(badSlot)}`,
    );

    const badToken = await trpcMutation(
      "upsertEmailTemplateOverride",
      {
        templateKey: TEST_TEMPLATE,
        subjectOverride: "Hello {notAToken}",
        slotOverrides: {},
        enabled: true,
      },
      adminJwt,
    );
    assert.ok(
      isErr(badToken) && badToken.error.data.code === "BAD_REQUEST",
      `unknown token rejected: ${JSON.stringify(badToken)}`,
    );

    const badSubject = await trpcMutation(
      "upsertEmailTemplateOverride",
      {
        templateKey: NO_SUBJECT_TEMPLATE,
        subjectOverride: "cannot override this",
        slotOverrides: {},
        enabled: true,
      },
      adminJwt,
    );
    assert.ok(
      isErr(badSubject) && badSubject.error.data.code === "BAD_REQUEST",
      `caller-composed subject override rejected: ${JSON.stringify(badSubject)}`,
    );
  });

  it("Test 4: FALLBACK — preview with no overrides is byte-identical to the default render", async () => {
    const sample = EMAIL_TEMPLATE_SAMPLE_DATA[TEST_TEMPLATE];
    const def = await renderTemplate(TEST_TEMPLATE, sample);
    const prev = await trpcQuery<PreviewOut>(
      "previewEmailTemplate",
      { templateKey: TEST_TEMPLATE },
      adminJwt,
    );
    assert.ok(!isErr(prev), `preview: ${JSON.stringify(prev)}`);
    assert.equal(prev.result.data.subject, def.subject, "subject matches default");
    assert.equal(prev.result.data.html, def.html, "html byte-identical to default");
  });

  it("Test 5: overrides applied — token interpolation matches the resolved render", async () => {
    const sample = EMAIL_TEMPLATE_SAMPLE_DATA[TEST_TEMPLATE] as {
      candidateName: string;
      positionTitle: string;
    };
    const subjectOverride = "Your {positionTitle} application — an update";
    const slotOverrides = { greeting: "Dear {candidateName}!" };

    const resolved = await renderTemplate(TEST_TEMPLATE, sample, {
      subject: subjectOverride,
      slots: slotOverrides,
    });
    // Subject interpolated with the sample position title.
    assert.ok(
      resolved.subject.includes(sample.positionTitle),
      "subject interpolates {positionTitle}",
    );
    // Slot interpolated with the sample candidate name.
    assert.ok(
      resolved.html.includes(`Dear ${sample.candidateName}!`),
      "slot interpolates {candidateName}",
    );

    const prev = await trpcQuery<PreviewOut>(
      "previewEmailTemplate",
      { templateKey: TEST_TEMPLATE, subjectOverride, slotOverrides },
      adminJwt,
    );
    assert.ok(!isErr(prev), `preview: ${JSON.stringify(prev)}`);
    assert.equal(prev.result.data.subject, resolved.subject, "preview subject == resolved render");
    assert.equal(prev.result.data.html, resolved.html, "preview html == resolved render");
  });

  it("Test 6: resetEmailTemplateOverride (admin) → catalog override back to null", async () => {
    const reset = await trpcMutation<{ reset: boolean }>(
      "resetEmailTemplateOverride",
      { templateKey: TEST_TEMPLATE },
      adminJwt,
    );
    assert.ok(!isErr(reset), `reset: ${JSON.stringify(reset)}`);
    assert.equal(reset.result.data.reset, true);

    const cat = await trpcQuery<CatalogOut>("getEmailTemplateCatalog", {}, adminJwt);
    assert.ok(!isErr(cat));
    const e = entry(cat.result.data, TEST_TEMPLATE);
    assert.equal(e.override, null, "override cleared after reset");
  });

  it("Test 7: tenant isolation — another tenant's override never leaks into the catalog", async () => {
    // Service-role insert (bypasses RLS) under a DIFFERENT tenant.
    await poolSql`
      INSERT INTO public.tenant_email_template_overrides
        (tenant_id, template_key, subject_override, slot_overrides, enabled, updated_at)
      VALUES
        (${OTHER_TENANT_ID}, ${TEST_TEMPLATE}, 'OTHER-TENANT LEAK PROBE', '{}'::jsonb, true, now())
      ON CONFLICT (tenant_id, template_key) DO UPDATE SET subject_override = EXCLUDED.subject_override
    `;

    const cat = await trpcQuery<CatalogOut>("getEmailTemplateCatalog", {}, adminJwt);
    assert.ok(!isErr(cat), `catalog: ${JSON.stringify(cat)}`);
    const e = entry(cat.result.data, TEST_TEMPLATE);
    assert.notEqual(
      e.override?.subjectOverride,
      "OTHER-TENANT LEAK PROBE",
      "another tenant's override is not visible (tenant isolation)",
    );

    const list = await trpcQuery<{ rows: OverrideRow[] }>(
      "listEmailTemplateOverrides",
      {},
      adminJwt,
    );
    assert.ok(!isErr(list));
    const leaked = list.result.data.rows.find(
      (r) => r.subjectOverride === "OTHER-TENANT LEAK PROBE",
    );
    assert.equal(leaked, undefined, "leak probe absent from list");
  });
});
