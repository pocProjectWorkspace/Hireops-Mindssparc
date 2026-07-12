/**
 * AGENT-02 — tRPC tests for createFollowUpAgent + listAgents.
 *
 * Coverage (5 cases):
 *   1. createFollowUpAgent happy path: 1 automation_agents + 1
 *      agent_triggers + 2 agent_actions (draft + send, ordered) + 2
 *      agent_approval_rules (auto + human_required). Returns agentId.
 *   2. createFollowUpAgent name uniqueness on active rows: second
 *      create with same name returns BAD_REQUEST (23505 mapped).
 *   3. createFollowUpAgent name uniqueness lifted on retired_at: after
 *      manually setting retired_at on the first agent, creating a new
 *      one with the same name succeeds. Verifies the partial-unique
 *      index `(tenant_id, name) WHERE retired_at IS NULL`.
 *   4. listAgents shape: returns the active agents with computed counts
 *      (pending_approval_count=0, total_runs=0, last_run_at=null for a
 *      fresh agent).
 *   5. listAgents tenant isolation: an agent inserted into a synthetic
 *      tenant via service_role is NOT visible to the test user.
 *
 * ADMIN-01 adds getAgentDetail coverage (3 cases):
 *   6. getAgentDetail round-trip for a created follow-up agent — agent
 *      header fields, triggers, ordered actions, approvalRules all
 *      present + correctly shaped; recentRuns empty for a fresh agent.
 *   7. getAgentDetail NOT_FOUND for a random uuid.
 *   8. getAgentDetail tenant isolation — an agent in a synthetic other
 *      tenant reads as NOT_FOUND from the test user's context.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

// Stable UUIDs (hex suffix, v4 structure). AGENT-02-test prefix.
const A02T_SYNTH_TENANT = "00000000-0000-4000-8000-00000a02e001";
const A02T_SYNTH_MEMBERSHIP = "00000000-0000-4000-8000-00000a02e002";
const A02T_SYNTH_AUTH_USER = "00000000-0000-4000-8000-00000a02e003";
const A02T_SYNTH_AGENT = "00000000-0000-4000-8000-00000a02e004";

// ADMIN-01 getAgentDetail fixtures (separate ids so the isolation test
// doesn't depend on Test 5's synth-tenant rows still existing).
const AD01_SYNTH_TENANT = "00000000-0000-4000-8000-0000ad01e001";
const AD01_SYNTH_MEMBERSHIP = "00000000-0000-4000-8000-0000ad01e002";
const AD01_SYNTH_AGENT = "00000000-0000-4000-8000-0000ad01e003";
const AD01_MISSING_AGENT = "00000000-0000-4000-8000-0000ad01ffff";

// ADMIN-02 listAuditEvents fixtures.
const AD02_SYNTH_TENANT = "00000000-0000-4000-8000-0000ad02e001";
const AD02_SYNTH_ENTITY = "00000000-0000-4000-8000-0000ad02e0ff";

const NAME_AUDIT_INSERT = "admin-02-test-audit-insert";
const NAME_AUDIT_TOGGLE = "admin-02-test-audit-toggle";

const NAME_HAPPY = "agent-02-test-happy";
const NAME_UNIQUE = "agent-02-test-unique-collide";
const NAME_RETIRED = "agent-02-test-retire-reuse";
const NAME_LIST = "agent-02-test-list";
const NAME_SYNTH = "agent-02-test-synth-invisible";
const NAME_DETAIL = "admin-01-test-detail";
const NAME_AD01_SYNTH = "admin-01-test-synth-invisible";

let jwt: string;
let testTenantId: string;

interface TRPCSuccess<T> { result: { data: T } }
interface TRPCErr { error: { data: { code: string; httpStatus?: number } } }
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin: ${error?.message}`);
  return data.session.access_token;
}

async function trpcMutation<O>(name: string, input: unknown): Promise<TRPCSuccess<O> | TRPCErr> {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function trpcQuery<O>(name: string, input: unknown = undefined): Promise<TRPCSuccess<O> | TRPCErr> {
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function deleteAgentsByName(name: string): Promise<void> {
  // Children first.
  await poolSql`
    DELETE FROM public.agent_approval_rules
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_actions
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_triggers
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`DELETE FROM public.automation_agents WHERE name = ${name}`;
}

async function cleanupSynthTenant(): Promise<void> {
  await poolSql`DELETE FROM public.agent_approval_rules WHERE agent_id = ${A02T_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.agent_actions WHERE agent_id = ${A02T_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.agent_triggers WHERE agent_id = ${A02T_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.automation_agents WHERE id = ${A02T_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE id = ${A02T_SYNTH_MEMBERSHIP}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${A02T_SYNTH_TENANT}`;
}

async function cleanupAd01Synth(): Promise<void> {
  await poolSql`DELETE FROM public.agent_approval_rules WHERE agent_id = ${AD01_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.agent_actions WHERE agent_id = ${AD01_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.agent_triggers WHERE agent_id = ${AD01_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.automation_agents WHERE id = ${AD01_SYNTH_AGENT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE id = ${AD01_SYNTH_MEMBERSHIP}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${AD01_SYNTH_TENANT}`;
}

async function cleanupAd02Synth(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${AD02_SYNTH_TENANT}`;
}

describe("AGENT-02 — tRPC createFollowUpAgent + listAgents", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    // Defensive pre-cleanup.
    for (const n of [
      NAME_HAPPY,
      NAME_UNIQUE,
      NAME_RETIRED,
      NAME_LIST,
      NAME_SYNTH,
      NAME_DETAIL,
      NAME_AD01_SYNTH,
      NAME_AUDIT_INSERT,
      NAME_AUDIT_TOGGLE,
    ]) {
      await deleteAgentsByName(n);
    }
    await cleanupSynthTenant();
    await cleanupAd01Synth();
    await cleanupAd02Synth();
  });

  afterAll(async () => {
    for (const n of [
      NAME_HAPPY,
      NAME_UNIQUE,
      NAME_RETIRED,
      NAME_LIST,
      NAME_SYNTH,
      NAME_DETAIL,
      NAME_AD01_SYNTH,
      NAME_AUDIT_INSERT,
      NAME_AUDIT_TOGGLE,
    ]) {
      await deleteAgentsByName(n);
    }
    await cleanupSynthTenant();
    await cleanupAd01Synth();
    await cleanupAd02Synth();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: createFollowUpAgent happy path — 1 agent + 1 trigger + 2 actions + 2 approval rules", async () => {
    const env = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_HAPPY,
      description: "Test agent",
      days_threshold: 5,
      stage: "tech_screen",
      tone: "friendly",
      max_tokens: 200,
    });
    assert.ok(!isErr(env), `mutation should succeed: ${JSON.stringify(env)}`);
    const agentId = env.result.data.agentId;
    assert.match(agentId, /^[0-9a-f-]{36}$/);

    // automation_agents row.
    const [agent] = await poolSql<
      { id: string; agent_type: string; enabled: boolean; version: number }[]
    >`
      SELECT id, agent_type, enabled, version FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(agent?.agent_type, "follow_up");
    assert.equal(agent?.enabled, true);
    assert.equal(agent?.version, 1);

    // 1 trigger, stage_stale, with days_threshold + stage.
    const triggers = await poolSql<
      { trigger_type: string; trigger_config: { stage: string; days_threshold: number } }[]
    >`
      SELECT trigger_type, trigger_config FROM public.agent_triggers WHERE agent_id = ${agentId}
    `;
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0]?.trigger_type, "stage_stale");
    assert.equal(triggers[0]?.trigger_config.stage, "tech_screen");
    assert.equal(triggers[0]?.trigger_config.days_threshold, 5);

    // 2 actions, ordered, with curated defaults.
    const actions = await poolSql<
      {
        action_order: number;
        action_type: string;
        action_config: Record<string, unknown>;
      }[]
    >`
      SELECT action_order, action_type, action_config FROM public.agent_actions
      WHERE agent_id = ${agentId} ORDER BY action_order
    `;
    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.action_type, "draft_message");
    assert.equal(actions[0]?.action_config.template_prompt_id, "follow_up_v1");
    assert.equal(actions[0]?.action_config.tone, "friendly");
    assert.equal(actions[0]?.action_config.max_tokens, 200);
    assert.equal(actions[1]?.action_type, "send_message");
    assert.equal(actions[1]?.action_config.outbox_kind, "agent_followup");

    // 2 approval rules with the documented mode + role pairing.
    // Re-fetch action ids so we can correlate to rules.
    const actionIds = await poolSql<{ id: string; action_order: number }[]>`
      SELECT id, action_order FROM public.agent_actions WHERE agent_id = ${agentId} ORDER BY action_order
    `;
    const rules = await poolSql<
      { approval_mode: string; approver_role: string | null; action_id: string }[]
    >`
      SELECT approval_mode, approver_role, action_id FROM public.agent_approval_rules
      WHERE agent_id = ${agentId}
    `;
    assert.equal(rules.length, 2);
    const draftRule = rules.find((r) => r.action_id === actionIds[0]!.id);
    const sendRule = rules.find((r) => r.action_id === actionIds[1]!.id);
    // FOLLOWUP-01 swapped these. The gate sits on the PURE action
    // (draft_message) because the drain executes-then-gates and skips
    // re-execution on resume — gating the effectful send_message would
    // have enqueued the email before the recruiter ever saw the draft.
    assert.equal(draftRule?.approval_mode, "human_required");
    assert.equal(draftRule?.approver_role, "owning_recruiter");
    assert.equal(sendRule?.approval_mode, "auto");
    assert.equal(sendRule?.approver_role, null);
  });

  it("Test 2: createFollowUpAgent rejects duplicate active name with BAD_REQUEST", async () => {
    const first = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_UNIQUE,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(!isErr(first), `first create should succeed: ${JSON.stringify(first)}`);

    const second = await trpcMutation("createFollowUpAgent", {
      name: NAME_UNIQUE,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(isErr(second), `second create should fail: ${JSON.stringify(second)}`);
    assert.equal(second.error.data.code, "BAD_REQUEST");
  });

  it("Test 3: name re-use after retire — partial-unique index `(tenant_id, name) WHERE retired_at IS NULL` lifts after retire", async () => {
    const first = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_RETIRED,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "formal",
      max_tokens: 200,
    });
    assert.ok(!isErr(first), `first create should succeed: ${JSON.stringify(first)}`);
    const firstId = first.result.data.agentId;

    // Retire the first agent (AGENT-04 will expose a procedure for
    // this; AGENT-02 does it directly via SQL to test the index).
    await poolSql`
      UPDATE public.automation_agents SET retired_at = now() WHERE id = ${firstId}
    `;

    const second = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_RETIRED,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "formal",
      max_tokens: 200,
    });
    assert.ok(!isErr(second), `second create after retire should succeed: ${JSON.stringify(second)}`);
    assert.notEqual(second.result.data.agentId, firstId);
  });

  it("Test 4: listAgents returns the just-created agent with counts (0, 0, null) and excludes retired rows", async () => {
    const created = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_LIST,
      days_threshold: 7,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(!isErr(created), `create should succeed: ${JSON.stringify(created)}`);
    const createdId = created.result.data.agentId;

    const list = await trpcQuery<{
      agents: Array<{
        id: string;
        name: string;
        enabled: boolean;
        pending_approval_count: number;
        total_runs: number;
        last_run_at: string | null;
        retired_at: string | null;
      }>;
    }>("listAgents");
    assert.ok(!isErr(list), `query should succeed: ${JSON.stringify(list)}`);
    const found = list.result.data.agents.find((a) => a.id === createdId);
    assert.ok(found, "newly created agent should appear in listAgents");
    assert.equal(found?.name, NAME_LIST);
    assert.equal(found?.enabled, true);
    assert.equal(found?.pending_approval_count, 0);
    assert.equal(found?.total_runs, 0);
    assert.equal(found?.last_run_at, null);
    assert.equal(found?.retired_at, null);

    // Every returned agent must have retired_at = null (the procedure
    // filters in SQL — defensive belt-and-braces here).
    for (const a of list.result.data.agents) {
      assert.equal(a.retired_at, null, `listAgents returned a retired agent: ${a.name}`);
    }
  });

  it("Test 5: listAgents tenant-isolates — agent in a different tenant is invisible", async () => {
    // Seed a synth tenant + membership entry pointing at a real auth.users
    // row — we can't fabricate an auth.users id, so use the test user's
    // id but bind it to the synth tenant for the membership FK.
    const claims = decodeJwt(jwt);
    const realUserId = claims.sub as string;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${A02T_SYNTH_TENANT}, ${`a02e-synth-${A02T_SYNTH_TENANT.slice(-6)}`},
              'AGENT-02 Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status)
      VALUES (${A02T_SYNTH_MEMBERSHIP}, ${A02T_SYNTH_TENANT}, ${realUserId},
              ARRAY['admin']::tenant_role[], 'active')
    `;
    // Insert the synth agent directly via service_role.
    await poolSql`
      INSERT INTO public.automation_agents
        (id, tenant_id, agent_type, name, description, enabled, version, created_by)
      VALUES (${A02T_SYNTH_AGENT}, ${A02T_SYNTH_TENANT}, 'follow_up',
              ${NAME_SYNTH}, 'should be invisible', true, 1, ${A02T_SYNTH_MEMBERSHIP})
    `;

    const list = await trpcQuery<{ agents: Array<{ id: string; name: string }> }>("listAgents");
    assert.ok(!isErr(list), `query should succeed: ${JSON.stringify(list)}`);
    const synthVisible = list.result.data.agents.find((a) => a.id === A02T_SYNTH_AGENT);
    assert.equal(
      synthVisible,
      undefined,
      `synthetic-tenant agent should be invisible — RLS should hide it`,
    );
    assert.equal(
      list.result.data.agents.find((a) => a.name === NAME_SYNTH),
      undefined,
      `synth name should not appear either`,
    );
  });

  it("Test 6: getAgentDetail round-trips a created follow-up agent (agent + triggers + actions + rules; empty runs)", async () => {
    const created = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_DETAIL,
      description: "Detail round-trip agent",
      days_threshold: 6,
      stage: "tech_screen",
      tone: "friendly",
      max_tokens: 200,
    });
    assert.ok(!isErr(created), `create should succeed: ${JSON.stringify(created)}`);
    const createdId = created.result.data.agentId;

    const detail = await trpcQuery<{
      agent: {
        id: string;
        agent_type: string;
        name: string;
        description: string | null;
        enabled: boolean;
        version: number;
        created_at: string;
        retired_at: string | null;
      };
      triggers: Array<{ id: string; trigger_type: string; trigger_config: { stage?: string } }>;
      actions: Array<{
        id: string;
        action_order: number;
        action_type: string;
        action_config: Record<string, unknown>;
      }>;
      approvalRules: Array<{
        id: string;
        action_id: string;
        approval_mode: string;
        approver_role: string | null;
      }>;
      recentRuns: Array<{ id: string; status: string }>;
    }>("getAgentDetail", { agentId: createdId });
    assert.ok(!isErr(detail), `query should succeed: ${JSON.stringify(detail)}`);
    const d = detail.result.data;

    // Agent header.
    assert.equal(d.agent.id, createdId);
    assert.equal(d.agent.agent_type, "follow_up");
    assert.equal(d.agent.name, NAME_DETAIL);
    assert.equal(d.agent.enabled, true);
    assert.equal(d.agent.version, 1);
    assert.equal(d.agent.retired_at, null);
    assert.ok(typeof d.agent.created_at === "string" && d.agent.created_at.length > 0);

    // Trigger — one stage_stale trigger with the curated config.
    assert.equal(d.triggers.length, 1);
    assert.equal(d.triggers[0]?.trigger_type, "stage_stale");
    assert.equal(d.triggers[0]?.trigger_config.stage, "tech_screen");

    // Actions — draft then send, ordered by action_order.
    assert.equal(d.actions.length, 2);
    assert.equal(d.actions[0]?.action_type, "draft_message");
    assert.equal(d.actions[1]?.action_type, "send_message");
    assert.ok(
      (d.actions[0]?.action_order ?? Number.MAX_SAFE_INTEGER) <
        (d.actions[1]?.action_order ?? Number.MIN_SAFE_INTEGER),
      "actions must be ordered by action_order",
    );

    // Approval rules — two, each attached to one of the returned actions.
    assert.equal(d.approvalRules.length, 2);
    const actionIds = new Set(d.actions.map((a) => a.id));
    for (const r of d.approvalRules) {
      assert.ok(
        actionIds.has(r.action_id),
        `approval rule action_id ${r.action_id} must reference a returned action`,
      );
      assert.ok(typeof r.approval_mode === "string" && r.approval_mode.length > 0);
    }

    // Fresh agent → no run history yet.
    assert.equal(d.recentRuns.length, 0);
  });

  it("Test 7: getAgentDetail returns NOT_FOUND for a random uuid", async () => {
    const res = await trpcQuery("getAgentDetail", { agentId: AD01_MISSING_AGENT });
    assert.ok(isErr(res), `query should fail: ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "NOT_FOUND");
  });

  it("Test 8: getAgentDetail tenant-isolates — an agent in another tenant reads as NOT_FOUND", async () => {
    const claims = decodeJwt(jwt);
    const realUserId = claims.sub as string;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${AD01_SYNTH_TENANT}, ${`ad01-synth-${AD01_SYNTH_TENANT.slice(-6)}`},
              'ADMIN-01 Synth', 'ap-northeast-1', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status)
      VALUES (${AD01_SYNTH_MEMBERSHIP}, ${AD01_SYNTH_TENANT}, ${realUserId},
              ARRAY['admin']::tenant_role[], 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.automation_agents
        (id, tenant_id, agent_type, name, description, enabled, version, created_by)
      VALUES (${AD01_SYNTH_AGENT}, ${AD01_SYNTH_TENANT}, 'follow_up',
              ${NAME_AD01_SYNTH}, 'cross-tenant hidden', true, 1, ${AD01_SYNTH_MEMBERSHIP})
      ON CONFLICT (id) DO NOTHING
    `;

    // The test user's JWT is scoped to testTenant; the synth agent lives
    // in AD01_SYNTH_TENANT. RLS + the explicit tenant filter must hide it,
    // and getAgentDetail surfaces that as NOT_FOUND (never a leak).
    const res = await trpcQuery("getAgentDetail", { agentId: AD01_SYNTH_AGENT });
    assert.ok(isErr(res), `cross-tenant read should fail: ${JSON.stringify(res)}`);
    assert.equal(res.error.data.code, "NOT_FOUND");
  });

  // ─────────────────────── ADMIN-02 — listAuditEvents ───────────────────────

  interface AuditRow {
    id: string;
    entity_type: string;
    entity_id: string;
    action: string;
    actor_user_id: string | null;
    actor_membership_id: string | null;
    request_id: string | null;
    source: string;
    changed_columns: string[] | null;
    before_data: unknown;
    after_data: unknown;
    created_at: string;
  }
  interface AuditPage {
    items: AuditRow[];
    nextCursor: string | null;
  }

  it("Test 9: listAuditEvents surfaces the automation_agents insert row for a freshly created agent with after_data", async () => {
    const created = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_AUDIT_INSERT,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(!isErr(created), `create should succeed: ${JSON.stringify(created)}`);
    const agentId = created.result.data.agentId;

    const res = await trpcQuery<AuditPage>("listAuditEvents", {
      entityTypes: ["automation_agents"],
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    for (const row of res.result.data.items) {
      assert.equal(
        row.entity_type,
        "automation_agents",
        "entityTypes filter must narrow to automation_agents only",
      );
    }
    const insertRow = res.result.data.items.find(
      (r) => r.entity_id === agentId && r.action === "insert",
    );
    assert.ok(insertRow, "insert audit row for the new agent should be present");
    assert.ok(insertRow.after_data, "after_data should be populated on an insert row");
    assert.equal(
      (insertRow.after_data as { name?: string }).name,
      NAME_AUDIT_INSERT,
      "after_data should carry the inserted row snapshot",
    );
  });

  it("Test 10: listAuditEvents action + entityId filters narrow to the toggle update", async () => {
    const created = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_AUDIT_TOGGLE,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(!isErr(created), `create should succeed: ${JSON.stringify(created)}`);
    const agentId = created.result.data.agentId;

    // Toggle enabled false → in-place UPDATE → an 'update' audit row.
    const toggled = await trpcMutation("toggleFollowUpAgent", {
      agentId,
      enabled: false,
    });
    assert.ok(!isErr(toggled), `toggle should succeed: ${JSON.stringify(toggled)}`);

    const res = await trpcQuery<AuditPage>("listAuditEvents", {
      action: "update",
      entityId: agentId,
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const items = res.result.data.items;
    assert.ok(items.length >= 1, "at least one update row for the toggled agent");
    for (const row of items) {
      assert.equal(row.action, "update", "action filter must narrow to updates");
      assert.equal(row.entity_id, agentId, "entityId filter must narrow to the toggled agent");
    }
    const enabledUpdate = items.find((r) => (r.changed_columns ?? []).includes("enabled"));
    assert.ok(enabledUpdate, "the enabled toggle should appear in changed_columns");
    assert.equal(
      (enabledUpdate.after_data as { enabled?: boolean }).enabled,
      false,
      "after_data should reflect the toggled-off state",
    );
  });

  it("Test 11: listAuditEvents tenant-isolates — an audit row in another tenant is invisible", async () => {
    // Insert an audit row directly into a synthetic tenant via service_role.
    // audit_logs has no FK to tenants, so no tenant/membership seed needed;
    // RLS (tenant_id = current_tenant_id()) must hide it from the test user.
    await poolSql`
      INSERT INTO public.audit_logs (tenant_id, entity_type, entity_id, action, after_data)
      VALUES (${AD02_SYNTH_TENANT}, 'automation_agents', ${AD02_SYNTH_ENTITY}, 'insert',
              ${JSON.stringify({ name: "cross-tenant-hidden" })}::jsonb)
    `;

    const res = await trpcQuery<AuditPage>("listAuditEvents", {
      entityId: AD02_SYNTH_ENTITY,
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    assert.equal(
      res.result.data.items.length,
      0,
      "synthetic-tenant audit row must be invisible to the test tenant",
    );
  });

  it("Test 12: listAuditEvents cursor pages distinct rows in descending order", async () => {
    // The suite has generated plenty of automation_agents audit rows by now.
    const page1 = await trpcQuery<AuditPage>("listAuditEvents", {
      entityTypes: ["automation_agents"],
      limit: 1,
    });
    assert.ok(!isErr(page1), `page 1 should succeed: ${JSON.stringify(page1)}`);
    assert.equal(page1.result.data.items.length, 1, "page 1 returns exactly one row");
    assert.ok(page1.result.data.nextCursor, "page 1 should carry a nextCursor");
    const row1 = page1.result.data.items[0]!;

    const page2 = await trpcQuery<AuditPage>("listAuditEvents", {
      entityTypes: ["automation_agents"],
      limit: 1,
      cursor: page1.result.data.nextCursor,
    });
    assert.ok(!isErr(page2), `page 2 should succeed: ${JSON.stringify(page2)}`);
    assert.equal(page2.result.data.items.length, 1, "page 2 returns exactly one row");
    const row2 = page2.result.data.items[0]!;

    assert.notEqual(row1.id, row2.id, "page 2 must be a distinct row from page 1");
    // Descending by (created_at, id): row1 sorts at or after row2.
    assert.ok(
      row1.created_at > row2.created_at ||
        (row1.created_at === row2.created_at && row1.id > row2.id),
      `rows must descend: ${row1.created_at}/${row1.id} then ${row2.created_at}/${row2.id}`,
    );
  });
});
