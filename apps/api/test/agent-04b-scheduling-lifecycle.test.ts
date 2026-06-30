/**
 * AGENT-04b — lifecycle tests for the Scheduling agent CRUD surface.
 *
 * Six tests:
 *
 *   1. createSchedulingAgent happy path — 1 agent + 1 trigger
 *      (stage_entered) + 2 actions (propose_calendar_slots,
 *      create_calendar_event) + 1 approval rule (propose only,
 *      human_optional + owning_recruiter — the create_calendar_event
 *      action deliberately gets NO rule). This test also implicitly
 *      proves the AGENT-04b capability flip: the procedure calls
 *      ensureRuleAttachable("propose_calendar_slots", "human_optional")
 *      which would have thrown BAD_REQUEST pre-flip. A successful
 *      create IS the end-to-end confirmation.
 *
 *   2. updateSchedulingAgent — edit creates new version, old row
 *      retired, all children copied to the new row, ORIGINAL CHILDREN
 *      SURVIVE THE EDIT (cascade-never-fires assertion replicated from
 *      04a Test 1 — snapshot child ids, assert they still exist AND
 *      still point at the old agent_id), and an already-existing
 *      agent_runs row stays frozen on the old version.
 *
 *   3. retireSchedulingAgent — retired_at set, row no longer surfaces
 *      in listAgents, no new automation_agents row created. Double-
 *      retire returns BAD_REQUEST.
 *
 *   4. toggleSchedulingAgent — enabled flips, no new version row,
 *      re-enable round-trips. Retired-agent toggle is rejected.
 *
 *   5. #102 retrofit — duplicate active name returns clean BAD_REQUEST,
 *      no second row inserted.
 *
 *   6. Successive edits — version counter advances correctly; lineage
 *      by (tenant_id, name) returns the full version history.
 *
 * Setup pattern mirrors agent-04a-lifecycle.test.ts byte-for-byte
 * apart from the agent-type-specific input shape — that's the
 * "replicate the pattern" discipline AGENT-04b is exercising.
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

const NAME_CREATE = "agent-04b-sched-create";
const NAME_UPDATE = "agent-04b-sched-update";
const NAME_RETIRE = "agent-04b-sched-retire";
const NAME_TOGGLE = "agent-04b-sched-toggle";
const NAME_DUP = "agent-04b-sched-duplicate";
const NAME_MULTIEDIT = "agent-04b-sched-multiedit";

const PANEL_ID = "panel-04b-test";

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

describe("AGENT-04b — Scheduling agent create / update / retire / toggle lifecycle", () => {
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

  it("Test 1: createSchedulingAgent happy path — 1 agent + 1 trigger + 2 actions + 1 approval rule (capability flip exercised end-to-end)", async () => {
    const env = await trpcMutation<{ agentId: string }>("createSchedulingAgent", {
      name: NAME_CREATE,
      description: "Scheduling smoke",
      panel_id: PANEL_ID,
      slot_count: 4,
      window_days: 10,
      duration_minutes: 60,
    });
    assert.ok(!isErr(env), `create should succeed: ${JSON.stringify(env)}`);
    const agentId = env.result.data.agentId;

    // automation_agents row.
    const [agent] = await poolSql<
      { id: string; agent_type: string; enabled: boolean; version: number; name: string }[]
    >`
      SELECT id::text, agent_type, enabled, version, name
      FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(agent?.agent_type, "scheduling");
    assert.equal(agent?.enabled, true);
    assert.equal(agent?.version, 1);
    assert.equal(agent?.name, NAME_CREATE);

    // 1 trigger: stage_entered with stage=shortlisted (the curated default).
    const triggers = await poolSql<
      { trigger_type: string; trigger_config: { stage: string } }[]
    >`
      SELECT trigger_type, trigger_config FROM public.agent_triggers WHERE agent_id = ${agentId}
    `;
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0]?.trigger_type, "stage_entered");
    assert.equal(triggers[0]?.trigger_config.stage, "shortlisted");

    // 2 actions: propose then create_calendar_event, with HR's
    // panel_id / slot_count / window_days / duration_minutes applied
    // to action 1; action 2 carries panel_id + source_action_ref="1".
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
    assert.equal(actions[0]?.action_type, "propose_calendar_slots");
    assert.equal(actions[0]?.action_config.panel_id, PANEL_ID);
    assert.equal(actions[0]?.action_config.slot_count, 4);
    assert.equal(actions[0]?.action_config.window_days, 10);
    assert.equal(actions[0]?.action_config.duration_minutes, 60);
    assert.equal(actions[1]?.action_type, "create_calendar_event");
    assert.equal(actions[1]?.action_config.panel_id, PANEL_ID);
    assert.equal(actions[1]?.action_config.source_action_ref, "1");

    // EXACTLY ONE approval rule, on propose_calendar_slots only.
    // create_calendar_event has NO rule (worker defaults to auto-mode
    // when no rule attached — see agent-run-drain `ruleMode = rule
    // ?.approval_mode ?? "auto"`). This is also where the AGENT-04b
    // capability flip pays off end-to-end: pre-flip,
    // ensureRuleAttachable("propose_calendar_slots", "human_optional")
    // inside createSchedulingAgent would have thrown BAD_REQUEST and
    // the agent would never have been created — a successful create
    // proves the flip is wired through.
    const rules = await poolSql<
      { approval_mode: string; approver_role: string | null; action_id: string }[]
    >`
      SELECT approval_mode, approver_role, action_id::text
      FROM public.agent_approval_rules WHERE agent_id = ${agentId}
    `;
    assert.equal(rules.length, 1, "Scheduling has exactly one default rule (on propose only)");
    assert.equal(rules[0]?.approval_mode, "human_optional");
    assert.equal(rules[0]?.approver_role, "owning_recruiter");

    // Cross-check the rule's action_id points at the propose action,
    // not the create_calendar_event action.
    const proposeActionRow = await poolSql<{ id: string }[]>`
      SELECT id::text FROM public.agent_actions
      WHERE agent_id = ${agentId} AND action_type = 'propose_calendar_slots'
    `;
    assert.equal(rules[0]?.action_id, proposeActionRow[0]?.id);
  });

  it("Test 2: update creates a new version, retires the old, copies children, and old children + frozen runs survive", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createSchedulingAgent", {
      name: NAME_UPDATE,
      description: "v1 description",
      panel_id: PANEL_ID,
      slot_count: 3,
      window_days: 7,
      duration_minutes: 45,
    });
    assert.ok(!isErr(createEnv), `create v1 should succeed: ${JSON.stringify(createEnv)}`);
    const v1AgentId = createEnv.result.data.agentId;

    // Snapshot v1 children — the load-bearing values for the
    // cascade-never-fires assertion below.
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
    assert.equal(v1Rules.length, 1, "Scheduling v1 has exactly one rule");

    // Seed a frozen agent_runs row pointing at v1.
    const [frozenRun] = await poolSql<{ id: string; agent_id: string }[]>`
      INSERT INTO public.agent_runs
        (tenant_id, agent_id, triggered_by, trigger_context, status, completed_at, cost_micros)
      VALUES
        (${testTenantId}, ${v1AgentId}, 'system',
         ${JSON.stringify({ application_id: "agent-04b-sched-historical" })}::jsonb,
         'completed', now(), 0)
      RETURNING id, agent_id::text
    `;
    assert.ok(frozenRun);

    // Edit → v2. Change slot_count + duration_minutes; carry forward
    // panel_id, window_days, stage, description.
    const updateEnv = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateSchedulingAgent", {
      agentId: v1AgentId,
      slot_count: 5,
      duration_minutes: 60,
    });
    assert.ok(!isErr(updateEnv), `update should succeed: ${JSON.stringify(updateEnv)}`);
    assert.equal(updateEnv.result.data.previousAgentId, v1AgentId);
    assert.notEqual(updateEnv.result.data.agentId, v1AgentId, "new version has a fresh id");
    assert.equal(updateEnv.result.data.version, 2);
    const v2AgentId = updateEnv.result.data.agentId;

    // CASCADE-NEVER-FIRES assertion — every v1 child row must still
    // exist after the edit AND still reference v1AgentId. Replicates
    // agent-04a-lifecycle Test 1's shape exactly (snapshot ids before,
    // re-fetch by id after, count + each row's agent_id pointer).
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

    // v1 row retired, v2 row active, same name preserved.
    const [v1] = await poolSql<{ retired_at: Date | null; name: string; version: number }[]>`
      SELECT retired_at, name, version FROM public.automation_agents WHERE id = ${v1AgentId}
    `;
    assert.ok(v1?.retired_at, "v1 retired_at set");
    assert.equal(v1?.version, 1);
    assert.equal(v1?.name, NAME_UPDATE);

    const [v2] = await poolSql<{
      retired_at: Date | null;
      name: string;
      version: number;
      description: string | null;
    }[]>`
      SELECT retired_at, name, version, description FROM public.automation_agents WHERE id = ${v2AgentId}
    `;
    assert.equal(v2?.retired_at, null, "v2 active");
    assert.equal(v2?.version, 2);
    assert.equal(v2?.name, NAME_UPDATE, "name preserved across versions");
    assert.equal(v2?.description, "v1 description", "description carried forward when not in input");

    // v2 children — fresh ids, FK'd to v2AgentId, with input deltas
    // applied to propose_calendar_slots' config.
    const v2Actions = await poolSql<
      {
        id: string;
        action_type: string;
        action_config: Record<string, unknown>;
        action_order: number;
      }[]
    >`
      SELECT id::text, action_type, action_config, action_order
      FROM public.agent_actions WHERE agent_id = ${v2AgentId} ORDER BY action_order
    `;
    assert.equal(v2Actions.length, 2);
    assert.equal(v2Actions[0]?.action_type, "propose_calendar_slots");
    assert.equal(v2Actions[0]?.action_config.slot_count, 5, "slot_count from input");
    assert.equal(v2Actions[0]?.action_config.duration_minutes, 60, "duration_minutes from input");
    assert.equal(v2Actions[0]?.action_config.panel_id, PANEL_ID, "panel_id carried forward");
    assert.equal(v2Actions[0]?.action_config.window_days, 7, "window_days carried forward");
    assert.equal(v2Actions[1]?.action_type, "create_calendar_event");
    for (const a of v2Actions) {
      assert.ok(!v1Actions.find((v1a) => v1a.id === a.id), "v2 action ids are fresh");
    }

    // v2 rule — same shape (human_optional + owning_recruiter), action_id
    // rewired to the new propose_calendar_slots id.
    const v2Rules = await poolSql<
      { action_id: string; approval_mode: string; approver_role: string | null }[]
    >`
      SELECT action_id::text, approval_mode, approver_role
      FROM public.agent_approval_rules WHERE agent_id = ${v2AgentId}
    `;
    assert.equal(v2Rules.length, 1);
    assert.equal(v2Rules[0]?.approval_mode, "human_optional");
    assert.equal(v2Rules[0]?.approver_role, "owning_recruiter");
    const v2ProposeActionId = v2Actions.find((a) => a.action_type === "propose_calendar_slots")?.id;
    assert.equal(v2Rules[0]?.action_id, v2ProposeActionId, "rule rewired to v2 propose action");

    // Frozen agent_run stays pinned to v1AgentId.
    const [frozenAfter] = await poolSql<{ agent_id: string }[]>`
      SELECT agent_id::text FROM public.agent_runs WHERE id = ${frozenRun!.id}
    `;
    assert.equal(
      frozenAfter?.agent_id,
      v1AgentId,
      "frozen agent_run stays pinned to the version it ran against",
    );

    // listAgents returns v2 (active), not v1 (retired).
    const listEnv = await trpcQuery<{
      agents: Array<{ id: string; name: string; version: number }>;
    }>("listAgents");
    assert.ok(!isErr(listEnv));
    const inList = listEnv.result.data.agents.filter((a) => a.name === NAME_UPDATE);
    assert.equal(inList.length, 1, "only the active version shows in listAgents");
    assert.equal(inList[0]?.id, v2AgentId);
    assert.equal(inList[0]?.version, 2);
  });

  it("Test 3: retire sets retired_at, removes the agent from listAgents, no new row", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createSchedulingAgent", {
      name: NAME_RETIRE,
      panel_id: PANEL_ID,
    });
    assert.ok(!isErr(createEnv));
    const agentId = createEnv.result.data.agentId;

    const before = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_RETIRE}`
    )[0]?.c;
    assert.equal(before, 1);

    const retireEnv = await trpcMutation<{ agentId: string; retiredAt: string }>(
      "retireSchedulingAgent",
      { agentId },
    );
    assert.ok(!isErr(retireEnv), `retire should succeed: ${JSON.stringify(retireEnv)}`);
    assert.equal(retireEnv.result.data.agentId, agentId);

    const [row] = await poolSql<{ retired_at: Date | null }[]>`
      SELECT retired_at FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.ok(row?.retired_at, "retired_at set");

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
      "retired agent absent from listAgents",
    );

    // Double-retire returns BAD_REQUEST.
    const retireAgain = await trpcMutation("retireSchedulingAgent", { agentId });
    assert.ok(isErr(retireAgain));
    assert.equal(retireAgain.error.data.code, "BAD_REQUEST");
  });

  it("Test 4: toggle flips enabled, no new version row, re-enable round-trips, retired agent rejects", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createSchedulingAgent", {
      name: NAME_TOGGLE,
      panel_id: PANEL_ID,
    });
    assert.ok(!isErr(createEnv));
    const agentId = createEnv.result.data.agentId;

    const [initial] = await poolSql<{ enabled: boolean; version: number }[]>`
      SELECT enabled, version FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(initial?.enabled, true);
    assert.equal(initial?.version, 1);

    const disableEnv = await trpcMutation<{ agentId: string; enabled: boolean }>(
      "toggleSchedulingAgent",
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
      "toggleSchedulingAgent",
      { agentId, enabled: true },
    );
    assert.ok(!isErr(enableEnv));
    assert.equal(enableEnv.result.data.enabled, true);

    await poolSql`UPDATE public.automation_agents SET retired_at = now() WHERE id = ${agentId}`;
    const toggleRetired = await trpcMutation("toggleSchedulingAgent", { agentId, enabled: false });
    assert.ok(isErr(toggleRetired));
    assert.equal(toggleRetired.error.data.code, "BAD_REQUEST");
  });

  it("Test 5: #102 retrofit — duplicate active name returns clean BAD_REQUEST, no second row", async () => {
    const first = await trpcMutation<{ agentId: string }>("createSchedulingAgent", {
      name: NAME_DUP,
      panel_id: PANEL_ID,
    });
    assert.ok(!isErr(first), `first create should succeed: ${JSON.stringify(first)}`);

    const second = await trpcMutation("createSchedulingAgent", {
      name: NAME_DUP,
      panel_id: "different-panel",
      slot_count: 5,
    });
    assert.ok(isErr(second), `second create should fail: ${JSON.stringify(second)}`);
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
    const v1 = await trpcMutation<{ agentId: string }>("createSchedulingAgent", {
      name: NAME_MULTIEDIT,
      panel_id: PANEL_ID,
    });
    assert.ok(!isErr(v1));
    const v1Id = v1.result.data.agentId;

    const v2 = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateSchedulingAgent", { agentId: v1Id, slot_count: 5 });
    assert.ok(!isErr(v2));
    assert.equal(v2.result.data.version, 2);
    const v2Id = v2.result.data.agentId;

    const v3 = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateSchedulingAgent", { agentId: v2Id, window_days: 14 });
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
    assert.equal(lineage.length, 3, "three versions in lineage");
    assert.equal(lineage[0]?.version, 1);
    assert.equal(lineage[0]?.id, v1Id);
    assert.ok(lineage[0]?.retired_at, "v1 retired");
    assert.equal(lineage[1]?.version, 2);
    assert.equal(lineage[1]?.id, v2Id);
    assert.ok(lineage[1]?.retired_at, "v2 retired");
    assert.equal(lineage[2]?.version, 3);
    assert.equal(lineage[2]?.id, v3Id);
    assert.equal(lineage[2]?.retired_at, null, "v3 is the active version");
  });
});
