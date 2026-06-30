/**
 * AGENT-04b — lifecycle tests for the Candidate Q&A agent CRUD surface.
 *
 * Six tests, mirroring agent-04b-scheduling-lifecycle.test.ts structure:
 *
 *   1. createCandidateQaAgent happy path — 1 agent + 1 trigger
 *      (message_received with locked channel='email', from='candidate')
 *      + 2 actions (draft_message, send_message) + 1 approval rule
 *      (send only, human_required + owning_recruiter — draft has no
 *      rule). Implicitly proves the create-path guard accepts
 *      human_required on send_message (send_message was already
 *      capable=true since AGENT-03).
 *
 *   2. updateCandidateQaAgent — edit creates new version, old row
 *      retired, all children copied, CASCADE-NEVER-FIRES (verbatim
 *      replication of agent-04a/04b-Scheduling Test 1 — snapshot
 *      child ids, assert they still exist AND still point at the
 *      old agent_id), frozen runs survive.
 *
 *   3. retireCandidateQaAgent — retired_at set, listAgents excludes,
 *      no new row. Double-retire returns BAD_REQUEST.
 *
 *   4. toggleCandidateQaAgent — enabled flips, no new version row,
 *      re-enable round-trips. Retired-agent toggle rejected.
 *
 *   5. #102 retrofit — duplicate active name returns clean BAD_REQUEST,
 *      no second row.
 *
 *   6. Successive edits — version counter advances; lineage by
 *      (tenant_id, name) returns full history.
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

const NAME_CREATE = "agent-04b-qa-create";
const NAME_UPDATE = "agent-04b-qa-update";
const NAME_RETIRE = "agent-04b-qa-retire";
const NAME_TOGGLE = "agent-04b-qa-toggle";
const NAME_DUP = "agent-04b-qa-duplicate";
const NAME_MULTIEDIT = "agent-04b-qa-multiedit";

let jwt: string;
let testTenantId: string;

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { data: { code: string } };
}
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
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function trpcQuery<O>(
  name: string,
  input: unknown = undefined,
): Promise<TRPCSuccess<O> | TRPCErr> {
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function deleteAllAgentsByName(name: string): Promise<void> {
  await poolSql`
    DELETE FROM public.agent_approval_requests
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_run_actions
    WHERE run_id IN (
      SELECT id FROM public.agent_runs
      WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
    )
  `;
  await poolSql`
    DELETE FROM public.agent_runs
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_run_outbox
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
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

describe("AGENT-04b — Candidate Q&A agent create / update / retire / toggle lifecycle", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    for (const n of [NAME_CREATE, NAME_UPDATE, NAME_RETIRE, NAME_TOGGLE, NAME_DUP, NAME_MULTIEDIT]) {
      await deleteAllAgentsByName(n);
    }
  });

  afterAll(async () => {
    for (const n of [NAME_CREATE, NAME_UPDATE, NAME_RETIRE, NAME_TOGGLE, NAME_DUP, NAME_MULTIEDIT]) {
      await deleteAllAgentsByName(n);
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: createCandidateQaAgent happy path — 1 agent + 1 trigger + 2 actions + 1 approval rule (guard accepts human_required on send_message)", async () => {
    const env = await trpcMutation<{ agentId: string }>("createCandidateQaAgent", {
      name: NAME_CREATE,
      description: "Candidate Q&A smoke",
      tone: "neutral",
      max_tokens: 250,
    });
    assert.ok(!isErr(env), `create should succeed: ${JSON.stringify(env)}`);
    const agentId = env.result.data.agentId;

    const [agent] = await poolSql<
      { id: string; agent_type: string; enabled: boolean; version: number; name: string }[]
    >`
      SELECT id::text, agent_type, enabled, version, name
      FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(agent?.agent_type, "candidate_qa");
    assert.equal(agent?.enabled, true);
    assert.equal(agent?.version, 1);
    assert.equal(agent?.name, NAME_CREATE);

    // Trigger: message_received with locked channel='email' and
    // from='candidate' (no HR knobs at AGENT-01a).
    const triggers = await poolSql<
      { trigger_type: string; trigger_config: { channel: string; from: string } }[]
    >`
      SELECT trigger_type, trigger_config FROM public.agent_triggers WHERE agent_id = ${agentId}
    `;
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0]?.trigger_type, "message_received");
    assert.equal(triggers[0]?.trigger_config.channel, "email");
    assert.equal(triggers[0]?.trigger_config.from, "candidate");

    // 2 actions: draft_message (HR knobs: tone, max_tokens; curated
    // template_prompt_id) + send_message (curated channel /
    // outbox_kind / requires_approval).
    const actions = await poolSql<
      {
        action_order: number;
        action_type: string;
        action_config: Record<string, unknown>;
      }[]
    >`
      SELECT action_order, action_type, action_config
      FROM public.agent_actions WHERE agent_id = ${agentId} ORDER BY action_order
    `;
    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.action_type, "draft_message");
    assert.equal(actions[0]?.action_config.template_prompt_id, "candidate_qa_v1");
    assert.equal(actions[0]?.action_config.tone, "neutral");
    assert.equal(actions[0]?.action_config.max_tokens, 250);
    assert.equal(actions[1]?.action_type, "send_message");
    assert.equal(actions[1]?.action_config.channel, "email");
    assert.equal(actions[1]?.action_config.outbox_kind, "candidate_qa_reply");
    assert.equal(actions[1]?.action_config.requires_approval, true);

    // EXACTLY ONE approval rule, on send_message. draft_message has
    // no rule (worker defaults to auto-mode for missing rules).
    // The presence of this row is also the end-to-end confirmation
    // that the create-path guard accepts human_required on
    // send_message (send_message has been requiresApprovalCapable=true
    // since AGENT-03; ensureRuleAttachable inside the procedure
    // would have thrown BAD_REQUEST if the capability ever regressed).
    const rules = await poolSql<
      { approval_mode: string; approver_role: string | null; action_id: string }[]
    >`
      SELECT approval_mode, approver_role, action_id::text
      FROM public.agent_approval_rules WHERE agent_id = ${agentId}
    `;
    assert.equal(rules.length, 1, "Candidate Q&A has exactly one default rule (on send only)");
    assert.equal(rules[0]?.approval_mode, "human_required");
    assert.equal(rules[0]?.approver_role, "owning_recruiter");

    const sendActionRow = await poolSql<{ id: string }[]>`
      SELECT id::text FROM public.agent_actions
      WHERE agent_id = ${agentId} AND action_type = 'send_message'
    `;
    assert.equal(rules[0]?.action_id, sendActionRow[0]?.id);
  });

  it("Test 2: update creates a new version, retires the old, copies children, and old children + frozen runs survive", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createCandidateQaAgent", {
      name: NAME_UPDATE,
      description: "v1 description",
      tone: "friendly",
      max_tokens: 200,
    });
    assert.ok(!isErr(createEnv), `create v1 should succeed: ${JSON.stringify(createEnv)}`);
    const v1AgentId = createEnv.result.data.agentId;

    // Snapshot v1 children.
    const v1Triggers = await poolSql<{ id: string }[]>`
      SELECT id FROM public.agent_triggers WHERE agent_id = ${v1AgentId}
    `;
    const v1Actions = await poolSql<{ id: string; action_type: string }[]>`
      SELECT id, action_type FROM public.agent_actions
      WHERE agent_id = ${v1AgentId} ORDER BY action_order
    `;
    const v1Rules = await poolSql<{ id: string; action_id: string }[]>`
      SELECT id, action_id FROM public.agent_approval_rules
      WHERE agent_id = ${v1AgentId}
    `;
    assert.equal(v1Triggers.length, 1);
    assert.equal(v1Actions.length, 2);
    assert.equal(v1Rules.length, 1, "Candidate Q&A v1 has exactly one rule");

    // Frozen agent_run pinned to v1.
    const [frozenRun] = await poolSql<{ id: string; agent_id: string }[]>`
      INSERT INTO public.agent_runs
        (tenant_id, agent_id, triggered_by, trigger_context, status, completed_at, cost_micros)
      VALUES
        (${testTenantId}, ${v1AgentId}, 'system',
         ${JSON.stringify({ application_id: "agent-04b-qa-historical" })}::jsonb,
         'completed', now(), 0)
      RETURNING id, agent_id::text
    `;
    assert.ok(frozenRun);

    // Edit → v2. Change tone + max_tokens.
    const updateEnv = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateCandidateQaAgent", {
      agentId: v1AgentId,
      tone: "formal",
      max_tokens: 300,
    });
    assert.ok(!isErr(updateEnv), `update should succeed: ${JSON.stringify(updateEnv)}`);
    assert.equal(updateEnv.result.data.previousAgentId, v1AgentId);
    assert.notEqual(updateEnv.result.data.agentId, v1AgentId, "new version has a fresh id");
    assert.equal(updateEnv.result.data.version, 2);
    const v2AgentId = updateEnv.result.data.agentId;

    // CASCADE-NEVER-FIRES assertion — replicates the 04a/Scheduling
    // shape exactly. Snapshot ids before edit, re-fetch by id after,
    // assert count holds AND each row still references v1AgentId.
    const v1TriggersAfter = await poolSql<{ id: string; agent_id: string }[]>`
      SELECT id, agent_id::text FROM public.agent_triggers
      WHERE id IN ${poolSql(v1Triggers.map((t) => t.id))}
    `;
    assert.equal(
      v1TriggersAfter.length,
      v1Triggers.length,
      "v1 triggers survive the edit — cascade must not have fired",
    );
    for (const t of v1TriggersAfter) assert.equal(t.agent_id, v1AgentId);

    const v1ActionsAfter = await poolSql<{ id: string; agent_id: string }[]>`
      SELECT id, agent_id::text FROM public.agent_actions
      WHERE id IN ${poolSql(v1Actions.map((a) => a.id))}
    `;
    assert.equal(v1ActionsAfter.length, v1Actions.length, "v1 actions survive");
    for (const a of v1ActionsAfter) assert.equal(a.agent_id, v1AgentId);

    const v1RulesAfter = await poolSql<{ id: string; agent_id: string }[]>`
      SELECT id, agent_id::text FROM public.agent_approval_rules
      WHERE id IN ${poolSql(v1Rules.map((r) => r.id))}
    `;
    assert.equal(v1RulesAfter.length, v1Rules.length, "v1 approval rule survives");
    for (const r of v1RulesAfter) assert.equal(r.agent_id, v1AgentId);

    // v1 retired, v2 active, same name preserved.
    const [v1] = await poolSql<{ retired_at: Date | null; name: string; version: number }[]>`
      SELECT retired_at, name, version FROM public.automation_agents WHERE id = ${v1AgentId}
    `;
    assert.ok(v1?.retired_at);
    assert.equal(v1?.version, 1);

    const [v2] = await poolSql<{
      retired_at: Date | null;
      name: string;
      version: number;
      description: string | null;
    }[]>`
      SELECT retired_at, name, version, description FROM public.automation_agents WHERE id = ${v2AgentId}
    `;
    assert.equal(v2?.retired_at, null);
    assert.equal(v2?.version, 2);
    assert.equal(v2?.name, NAME_UPDATE);
    assert.equal(v2?.description, "v1 description", "description carried forward");

    // v2 trigger — carried forward verbatim (no HR knobs on
    // message_received).
    const v2Triggers = await poolSql<
      { trigger_type: string; trigger_config: { channel: string; from: string } }[]
    >`
      SELECT trigger_type, trigger_config FROM public.agent_triggers WHERE agent_id = ${v2AgentId}
    `;
    assert.equal(v2Triggers.length, 1);
    assert.equal(v2Triggers[0]?.trigger_type, "message_received");
    assert.equal(v2Triggers[0]?.trigger_config.channel, "email");
    assert.equal(v2Triggers[0]?.trigger_config.from, "candidate");

    // v2 actions — fresh ids, input deltas applied to draft_message.
    const v2Actions = await poolSql<
      {
        id: string;
        action_type: string;
        action_config: Record<string, unknown>;
      }[]
    >`
      SELECT id::text, action_type, action_config
      FROM public.agent_actions WHERE agent_id = ${v2AgentId} ORDER BY action_order
    `;
    assert.equal(v2Actions.length, 2);
    assert.equal(v2Actions[0]?.action_type, "draft_message");
    assert.equal(v2Actions[0]?.action_config.tone, "formal", "draft tone from input");
    assert.equal(v2Actions[0]?.action_config.max_tokens, 300, "draft max_tokens from input");
    assert.equal(
      v2Actions[0]?.action_config.template_prompt_id,
      "candidate_qa_v1",
      "template_prompt_id carried forward",
    );
    assert.equal(v2Actions[1]?.action_type, "send_message");
    for (const a of v2Actions) {
      assert.ok(!v1Actions.find((v1a) => v1a.id === a.id), "v2 action ids are fresh");
    }

    // v2 rule — rewired to v2 send_message action_id.
    const v2Rules = await poolSql<
      { action_id: string; approval_mode: string; approver_role: string | null }[]
    >`
      SELECT action_id::text, approval_mode, approver_role
      FROM public.agent_approval_rules WHERE agent_id = ${v2AgentId}
    `;
    assert.equal(v2Rules.length, 1);
    assert.equal(v2Rules[0]?.approval_mode, "human_required");
    assert.equal(v2Rules[0]?.approver_role, "owning_recruiter");
    const v2SendActionId = v2Actions.find((a) => a.action_type === "send_message")?.id;
    assert.equal(v2Rules[0]?.action_id, v2SendActionId, "rule rewired to v2 send action");

    // Frozen run stays pinned to v1.
    const [frozenAfter] = await poolSql<{ agent_id: string }[]>`
      SELECT agent_id::text FROM public.agent_runs WHERE id = ${frozenRun!.id}
    `;
    assert.equal(frozenAfter?.agent_id, v1AgentId);

    // listAgents returns v2.
    const listEnv = await trpcQuery<{
      agents: Array<{ id: string; name: string; version: number }>;
    }>("listAgents");
    assert.ok(!isErr(listEnv));
    const inList = listEnv.result.data.agents.filter((a) => a.name === NAME_UPDATE);
    assert.equal(inList.length, 1);
    assert.equal(inList[0]?.id, v2AgentId);
    assert.equal(inList[0]?.version, 2);
  });

  it("Test 3: retire sets retired_at, removes from listAgents, no new row, double-retire rejected", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createCandidateQaAgent", {
      name: NAME_RETIRE,
    });
    assert.ok(!isErr(createEnv));
    const agentId = createEnv.result.data.agentId;

    const before = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_RETIRE}`
    )[0]?.c;
    assert.equal(before, 1);

    const retireEnv = await trpcMutation<{ agentId: string; retiredAt: string }>(
      "retireCandidateQaAgent",
      { agentId },
    );
    assert.ok(!isErr(retireEnv));

    const [row] = await poolSql<{ retired_at: Date | null }[]>`
      SELECT retired_at FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.ok(row?.retired_at);

    const after = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_RETIRE}`
    )[0]?.c;
    assert.equal(after, 1, "retire never inserts a new row");

    const listEnv = await trpcQuery<{
      agents: Array<{ id: string; name: string }>;
    }>("listAgents");
    assert.ok(!isErr(listEnv));
    assert.equal(
      listEnv.result.data.agents.find((a) => a.name === NAME_RETIRE),
      undefined,
    );

    const retireAgain = await trpcMutation("retireCandidateQaAgent", { agentId });
    assert.ok(isErr(retireAgain));
    assert.equal(retireAgain.error.data.code, "BAD_REQUEST");
  });

  it("Test 4: toggle flips enabled, no new version row, re-enable round-trips, retired agent rejects", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createCandidateQaAgent", {
      name: NAME_TOGGLE,
    });
    assert.ok(!isErr(createEnv));
    const agentId = createEnv.result.data.agentId;

    const disableEnv = await trpcMutation<{ agentId: string; enabled: boolean }>(
      "toggleCandidateQaAgent",
      { agentId, enabled: false },
    );
    assert.ok(!isErr(disableEnv));
    assert.equal(disableEnv.result.data.enabled, false);

    const [afterDisable] = await poolSql<{ enabled: boolean; version: number }[]>`
      SELECT enabled, version FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(afterDisable?.enabled, false);
    assert.equal(afterDisable?.version, 1, "toggle does NOT bump version");

    const count = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_TOGGLE}`
    )[0]?.c;
    assert.equal(count, 1);

    const enableEnv = await trpcMutation<{ agentId: string; enabled: boolean }>(
      "toggleCandidateQaAgent",
      { agentId, enabled: true },
    );
    assert.ok(!isErr(enableEnv));
    assert.equal(enableEnv.result.data.enabled, true);

    await poolSql`UPDATE public.automation_agents SET retired_at = now() WHERE id = ${agentId}`;
    const toggleRetired = await trpcMutation("toggleCandidateQaAgent", { agentId, enabled: false });
    assert.ok(isErr(toggleRetired));
    assert.equal(toggleRetired.error.data.code, "BAD_REQUEST");
  });

  it("Test 5: #102 retrofit — duplicate active name returns clean BAD_REQUEST, no second row", async () => {
    const first = await trpcMutation<{ agentId: string }>("createCandidateQaAgent", {
      name: NAME_DUP,
    });
    assert.ok(!isErr(first));

    const second = await trpcMutation("createCandidateQaAgent", {
      name: NAME_DUP,
      tone: "formal",
    });
    assert.ok(isErr(second));
    assert.equal(
      second.error.data.code,
      "BAD_REQUEST",
      "ON CONFLICT DO NOTHING path returns BAD_REQUEST, not INTERNAL",
    );

    const count = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_DUP}`
    )[0]?.c;
    assert.equal(count, 1, "duplicate INSERT was a no-op, not a rolled-back row");
  });

  it("Test 6: successive edits advance the version counter; lineage by (tenant, name) returns full history", async () => {
    const v1 = await trpcMutation<{ agentId: string }>("createCandidateQaAgent", {
      name: NAME_MULTIEDIT,
    });
    assert.ok(!isErr(v1));
    const v1Id = v1.result.data.agentId;

    const v2 = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateCandidateQaAgent", { agentId: v1Id, tone: "formal" });
    assert.ok(!isErr(v2));
    assert.equal(v2.result.data.version, 2);
    const v2Id = v2.result.data.agentId;

    const v3 = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateCandidateQaAgent", { agentId: v2Id, max_tokens: 400 });
    assert.ok(!isErr(v3));
    assert.equal(v3.result.data.version, 3);
    assert.equal(v3.result.data.previousAgentId, v2Id);
    const v3Id = v3.result.data.agentId;

    const lineage = await poolSql<
      { id: string; version: number; retired_at: Date | null }[]
    >`
      SELECT id::text, version, retired_at FROM public.automation_agents
      WHERE tenant_id = ${testTenantId} AND name = ${NAME_MULTIEDIT}
      ORDER BY version ASC
    `;
    assert.equal(lineage.length, 3);
    assert.equal(lineage[0]?.id, v1Id);
    assert.ok(lineage[0]?.retired_at);
    assert.equal(lineage[1]?.id, v2Id);
    assert.ok(lineage[1]?.retired_at);
    assert.equal(lineage[2]?.id, v3Id);
    assert.equal(lineage[2]?.retired_at, null);
  });
});
