/**
 * IRIS kill-switch — the per-tenant `iris_assistant` AI toggle governs BOTH
 * Iris AI calls.
 *
 * ONE feature key (`iris_assistant`) turns OFF both model-backed Iris calls:
 *   - irisResolveIntent  (NL → action, feature "iris_intent")
 *   - irisDraftCandidateMessage (candidate-message drafter, feature
 *     "iris_message_draft")
 *
 * With the tenant's iris_assistant DISABLED, both procedures must SKIP the model
 * up front and return their existing graceful-degrade result — the resolver's
 * "use the menu" message (actionId null) and the drafter's deterministic
 * templated draft — with NO model call and NO cost.
 *
 * Live-DB integration (shared dev/staging DB). kyndryl-poc's settings jsonb is
 * snapshotted in beforeAll and restored verbatim in afterAll. The primary
 * guarantee asserted is the DETERMINISTIC degrade RESULT shape (robust on the
 * shared pooler); a best-effort "no new ai_usage_logs row" check is layered on
 * top using a per-feature baseline captured immediately before each call, so a
 * pre-existing row from another run can't make it flaky.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1 on kyndryl-poc).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import type {
  AiSettings,
  IrisResolveIntentOutput,
  IrisDraftCandidateMessageOutput,
} from "@hireops/api-types";
import { IRIS_INTENT_DEGRADED_MESSAGE } from "../src/lib/iris/resolve-intent";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@mindssparc.com";
const RECRUITER = "recruiter1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

let adminJwt: string;
let recruiterJwt: string;
let tenantId: string;
let originalSettings: unknown;
/** An application in kyndryl-poc whose candidate carries an email — the
 * draft procedure requires resolvable email context. Discovered at runtime. */
let messageableApplicationId: string | null = null;

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

async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

/** Merge a per-feature aiSettings override onto kyndryl-poc, PRESERVING every
 * other aiSettings key + sibling settings key (the same jsonb-merge discipline
 * updateTenantAiSettings uses, scoped to one feature to keep blast radius tiny).
 * afterAll restores the whole snapshot verbatim regardless. */
async function setIrisAssistant(block: Record<string, unknown>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object(
             'aiSettings',
             COALESCE(settings->'aiSettings', '{}'::jsonb)
               || jsonb_build_object('iris_assistant', ${JSON.stringify(block)}::jsonb)
           )
    WHERE id = ${tenantId}
  `;
}

/** Count ai_usage_logs rows for this tenant + feature (baseline discipline —
 * asserted unchanged across a disabled call, robust against pre-existing rows). */
async function usageRowCount(feature: string): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.ai_usage_logs
    WHERE tenant_id = ${tenantId} AND feature = ${feature}
  `;
  return Number(row?.n ?? 0);
}

const DISABLED_BLOCK = {
  enabled: false,
  model: "claude-sonnet-4-6",
  temperature: 1,
  maxTokens: 4096,
};

describe("IRIS kill-switch — iris_assistant disables BOTH Iris AI calls", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};

    // Find any application in this tenant whose candidate has an email, so the
    // drafter's context resolves (it needs candidate name / role / company).
    const [appRow] = await poolSql<{ id: string }[]>`
      SELECT a.id
      FROM public.applications a
      JOIN public.candidates c ON c.id = a.candidate_id
      JOIN public.persons p ON p.id = c.person_id
      WHERE a.tenant_id = ${tenantId}
        AND p.email_primary IS NOT NULL
      LIMIT 1
    `;
    messageableApplicationId = appRow?.id ?? null;

    // Disable the switch for the duration of the run.
    await setIrisAssistant(DISABLED_BLOCK);
  });

  afterAll(async () => {
    // Restore kyndryl-poc's settings exactly as found (re-enables Iris AI).
    try {
      await poolSql`
        UPDATE public.tenants
        SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort — restore is idempotent
    }
  });

  it("Test 1: disabled → irisResolveIntent returns the menu message (actionId null), no iris_intent usage row", async () => {
    const baseline = await usageRowCount("iris_intent");

    const res = await trpcMutation<IrisResolveIntentOutput>(
      "irisResolveIntent",
      { text: "advance the backend candidate to the interview stage" },
      recruiterJwt,
    );
    assert.ok(!isErr(res), `expected degrade success, got ${JSON.stringify(res)}`);
    const out = res.result.data;

    // The resolver's OWN graceful-degrade shape — no proposed action, the calm
    // "use the menu" note. This is the single-sourced degrade text.
    assert.equal(out.actionId, null, "no action proposed while disabled");
    assert.equal(out.message, IRIS_INTENT_DEGRADED_MESSAGE, "menu-degrade message returned");
    assert.deepEqual(out.params, {}, "no draft params");

    // The model was skipped up front → no new cost row for iris_intent.
    const after = await usageRowCount("iris_intent");
    assert.equal(after, baseline, "no iris_intent ai_usage_logs row from the disabled call");
  });

  it("Test 2: disabled → irisDraftCandidateMessage returns a non-empty templated draft, no iris_message_draft usage row", async () => {
    if (!messageableApplicationId) {
      // No seeded application with a candidate email in this environment — the
      // pure degrade path is covered by iris-draft-candidate-message.test.ts;
      // skip the live wiring assertion rather than assert on absent data.
      // eslint-disable-next-line no-console
      console.warn("iris-kill-switch: no messageable application in kyndryl-poc; skipping Test 2");
      return;
    }

    const baseline = await usageRowCount("iris_message_draft");

    const res = await trpcMutation<IrisDraftCandidateMessageOutput>(
      "irisDraftCandidateMessage",
      {
        applicationId: messageableApplicationId,
        intent: "Let them know we're moving them to the final interview round.",
      },
      recruiterJwt,
    );
    assert.ok(!isErr(res), `expected degrade success, got ${JSON.stringify(res)}`);
    const draft = res.result.data;

    // The drafter's OWN deterministic templated draft — always non-empty so the
    // drawer stays usable, within the send-contract bounds.
    assert.ok(draft.subject.length > 0, "templated subject present");
    assert.ok(draft.body.length > 0, "templated body present");
    assert.ok(draft.subject.length <= 200 && draft.body.length <= 4000, "within send bounds");

    // The model was skipped up front → no new cost row for iris_message_draft.
    const after = await usageRowCount("iris_message_draft");
    assert.equal(after, baseline, "no iris_message_draft ai_usage_logs row from the disabled call");
  });

  it("Test 3: getTenantAiSettings exposes the new iris_assistant key (admin surface renders it)", async () => {
    const res = await trpcMutation<{ ok: true; settings: AiSettings }>(
      "updateTenantAiSettings",
      { iris_assistant: { enabled: false } },
      adminJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    // The resolved block round-trips the key through the admin write path, which
    // is what the admin AI-settings UI reads + renders a card for.
    assert.equal(res.result.data.settings.iris_assistant.enabled, false, "iris_assistant present");
  });
});
