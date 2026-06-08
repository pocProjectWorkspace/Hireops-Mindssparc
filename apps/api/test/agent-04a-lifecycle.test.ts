/**
 * AGENT-04a — lifecycle tests for the Follow-Up agent update / retire /
 * toggle surface.
 *
 * Five tests:
 *
 *   1. updateFollowUpAgent — edit creates new version, old row retired,
 *      all children copied to the new row, ORIGINAL CHILDREN SURVIVE
 *      THE EDIT (cascade-never-fires assertion), and an already-existing
 *      agent_runs row stays frozen on the old version.
 *
 *   2. retireFollowUpAgent — retired_at set, row no longer surfaces in
 *      listAgents, no new automation_agents row created.
 *
 *   3. toggleFollowUpAgent — enabled flips, no new version row created,
 *      re-enable round-trips cleanly.
 *
 *   4. #102 retrofit — duplicate active name returns BAD_REQUEST cleanly
 *      (clean 400, not INTERNAL_SERVER_ERROR), no second row inserted.
 *
 *   5. Update-then-edit-again — version counter advances correctly across
 *      multiple edits; lineage by (tenant_id, name) returns the full
 *      version history.
 *
 * Setup pattern mirrors agents.test.ts — JWT signin, tRPC mutations
 * via app.request, service-role assertions via poolSql.
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

const NAME_UPDATE = "agent-04a-update";
const NAME_RETIRE = "agent-04a-retire";
const NAME_TOGGLE = "agent-04a-toggle";
const NAME_DUP = "agent-04a-duplicate";
const NAME_MULTIEDIT = "agent-04a-multiedit";

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

/**
 * Delete every version of an agent by name + tenant — covers both
 * active and retired rows. Children cascade via the schema's ON DELETE
 * CASCADE FKs. agent_runs / agent_run_actions also cascade. Used only
 * for test setup/teardown — production code never deletes; it retires.
 */
async function deleteAllAgentsByName(name: string): Promise<void> {
  // Children first that aren't covered by cascade (defensive). Most
  // chains cascade from automation_agents; this list mirrors the
  // existing test cleanups in agents.test.ts and adds the AGENT-03
  // agent_approval_requests pre-clean.
  await poolSql`
    DELETE FROM public.agent_approval_requests
    WHERE agent_id IN (
      SELECT id FROM public.automation_agents WHERE name = ${name}
    )
  `;
  await poolSql`
    DELETE FROM public.agent_run_actions
    WHERE run_id IN (
      SELECT id FROM public.agent_runs
      WHERE agent_id IN (
        SELECT id FROM public.automation_agents WHERE name = ${name}
      )
    )
  `;
  await poolSql`
    DELETE FROM public.agent_runs
    WHERE agent_id IN (
      SELECT id FROM public.automation_agents WHERE name = ${name}
    )
  `;
  await poolSql`
    DELETE FROM public.agent_run_outbox
    WHERE agent_id IN (
      SELECT id FROM public.automation_agents WHERE name = ${name}
    )
  `;
  await poolSql`
    DELETE FROM public.agent_approval_rules
    WHERE agent_id IN (
      SELECT id FROM public.automation_agents WHERE name = ${name}
    )
  `;
  await poolSql`
    DELETE FROM public.agent_actions
    WHERE agent_id IN (
      SELECT id FROM public.automation_agents WHERE name = ${name}
    )
  `;
  await poolSql`
    DELETE FROM public.agent_triggers
    WHERE agent_id IN (
      SELECT id FROM public.automation_agents WHERE name = ${name}
    )
  `;
  await poolSql`DELETE FROM public.automation_agents WHERE name = ${name}`;
}

describe("AGENT-04a — Follow-Up agent update / retire / toggle lifecycle", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    for (const n of [NAME_UPDATE, NAME_RETIRE, NAME_TOGGLE, NAME_DUP, NAME_MULTIEDIT]) {
      await deleteAllAgentsByName(n);
    }
  });

  afterAll(async () => {
    for (const n of [NAME_UPDATE, NAME_RETIRE, NAME_TOGGLE, NAME_DUP, NAME_MULTIEDIT]) {
      await deleteAllAgentsByName(n);
    }
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: update creates a new version, retires the old, copies children, and old children + frozen runs survive", async () => {
    // 1. Create v1.
    const createEnv = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_UPDATE,
      description: "v1 description",
      days_threshold: 5,
      stage: "tech_screen",
      tone: "friendly",
      max_tokens: 200,
    });
    assert.ok(!isErr(createEnv), `create v1 should succeed: ${JSON.stringify(createEnv)}`);
    const v1AgentId = createEnv.result.data.agentId;

    // Snapshot the v1 children (ids + counts) so we can prove they
    // survive untouched after the edit.
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
    assert.equal(v1Rules.length, 2);

    // Seed a "frozen" agent_runs row pointing at v1. After the edit
    // we'll assert this row still references v1, not the new agent_id.
    const [frozenRun] = await poolSql<{ id: string; agent_id: string }[]>`
      INSERT INTO public.agent_runs
        (tenant_id, agent_id, triggered_by, trigger_context, status, completed_at, cost_micros)
      VALUES
        (${testTenantId}, ${v1AgentId}, 'system',
         ${JSON.stringify({ application_id: "agent-04a-historical" })}::jsonb,
         'completed', now(), 0)
      RETURNING id, agent_id::text
    `;
    assert.ok(frozenRun);

    // 2. Edit → v2. Change tone + days_threshold; carry forward stage,
    //    max_tokens, description.
    const updateEnv = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateFollowUpAgent", {
      agentId: v1AgentId,
      days_threshold: 9,
      tone: "neutral",
    });
    assert.ok(!isErr(updateEnv), `update should succeed: ${JSON.stringify(updateEnv)}`);
    assert.equal(updateEnv.result.data.previousAgentId, v1AgentId);
    assert.notEqual(updateEnv.result.data.agentId, v1AgentId, "new version has a fresh id");
    assert.equal(updateEnv.result.data.version, 2);
    const v2AgentId = updateEnv.result.data.agentId;

    // 3. CASCADE-NEVER-FIRES assertion: every original child row from
    //    v1 must still exist, pointing at v1AgentId.
    const v1TriggersAfter = await poolSql<{ id: string; agent_id: string }[]>`
      SELECT id, agent_id::text FROM public.agent_triggers WHERE id IN ${poolSql(v1Triggers.map((t) => t.id))}
    `;
    assert.equal(
      v1TriggersAfter.length,
      v1Triggers.length,
      "v1 triggers survive the edit — cascade must not have fired",
    );
    for (const t of v1TriggersAfter) assert.equal(t.agent_id, v1AgentId);

    const v1ActionsAfter = await poolSql<{ id: string; agent_id: string }[]>`
      SELECT id, agent_id::text FROM public.agent_actions WHERE id IN ${poolSql(v1Actions.map((a) => a.id))}
    `;
    assert.equal(v1ActionsAfter.length, v1Actions.length, "v1 actions survive");
    for (const a of v1ActionsAfter) assert.equal(a.agent_id, v1AgentId);

    const v1RulesAfter = await poolSql<{ id: string; agent_id: string }[]>`
      SELECT id, agent_id::text FROM public.agent_approval_rules WHERE id IN ${poolSql(v1Rules.map((r) => r.id))}
    `;
    assert.equal(v1RulesAfter.length, v1Rules.length, "v1 approval rules survive");
    for (const r of v1RulesAfter) assert.equal(r.agent_id, v1AgentId);

    // 4. v1 row is retired, v2 row is active, same name preserved.
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

    // 5. v2 children exist, with NEW ids, FK'd to v2AgentId, and the
    //    input deltas applied to the right child.
    const v2Triggers = await poolSql<{
      id: string;
      trigger_type: string;
      trigger_config: { stage: string; days_threshold: number };
    }[]>`
      SELECT id::text, trigger_type, trigger_config FROM public.agent_triggers WHERE agent_id = ${v2AgentId}
    `;
    assert.equal(v2Triggers.length, 1);
    assert.equal(v2Triggers[0]?.trigger_type, "stage_stale");
    assert.equal(v2Triggers[0]?.trigger_config.stage, "tech_screen", "stage carried forward");
    assert.equal(v2Triggers[0]?.trigger_config.days_threshold, 9, "days_threshold from input");
    assert.notEqual(v2Triggers[0]?.id, v1Triggers[0]?.id, "trigger id is fresh");

    const v2Actions = await poolSql<{
      id: string;
      action_type: string;
      action_config: Record<string, unknown>;
      action_order: number;
    }[]>`
      SELECT id::text, action_type, action_config, action_order
      FROM public.agent_actions WHERE agent_id = ${v2AgentId} ORDER BY action_order
    `;
    assert.equal(v2Actions.length, 2);
    assert.equal(v2Actions[0]?.action_type, "draft_message");
    assert.equal(v2Actions[0]?.action_config.tone, "neutral", "draft tone from input");
    assert.equal(v2Actions[0]?.action_config.max_tokens, 200, "max_tokens carried forward");
    assert.equal(v2Actions[1]?.action_type, "send_message");
    for (const a of v2Actions) {
      assert.ok(!v1Actions.find((v1a) => v1a.id === a.id), "v2 action ids are fresh");
    }

    const v2Rules = await poolSql<{
      action_id: string;
      approval_mode: string;
      approver_role: string | null;
    }[]>`
      SELECT action_id::text, approval_mode, approver_role
      FROM public.agent_approval_rules WHERE agent_id = ${v2AgentId}
    `;
    assert.equal(v2Rules.length, 2);
    // Each rule's action_id must reference a v2 action, not a v1 action.
    const v2ActionIds = new Set(v2Actions.map((a) => a.id));
    for (const r of v2Rules) {
      assert.ok(v2ActionIds.has(r.action_id), "rule.action_id rewired to v2 action");
    }
    // Approval modes preserved.
    const sendRule = v2Rules.find((r) => r.approval_mode === "human_required");
    const autoRule = v2Rules.find((r) => r.approval_mode === "auto");
    assert.ok(sendRule, "send_message rule copied with human_required");
    assert.equal(sendRule?.approver_role, "owning_recruiter");
    assert.ok(autoRule, "draft_message rule copied with auto");
    assert.equal(autoRule?.approver_role, null);

    // 6. Frozen agent_run still points at v1AgentId — historical
    //    runs are not migrated to the new version.
    const [frozenAfter] = await poolSql<{ agent_id: string }[]>`
      SELECT agent_id::text FROM public.agent_runs WHERE id = ${frozenRun!.id}
    `;
    assert.equal(
      frozenAfter?.agent_id,
      v1AgentId,
      "frozen agent_run stays pinned to the version it ran against",
    );

    // 7. listAgents returns v2 (active), not v1 (retired).
    const listEnv = await trpcQuery<{
      agents: Array<{ id: string; name: string; version: number; retired_at: string | null }>;
    }>("listAgents");
    assert.ok(!isErr(listEnv));
    const inList = listEnv.result.data.agents.filter((a) => a.name === NAME_UPDATE);
    assert.equal(inList.length, 1, "only the active version shows in listAgents");
    assert.equal(inList[0]?.id, v2AgentId);
    assert.equal(inList[0]?.version, 2);
  });

  it("Test 2: retire sets retired_at, removes the agent from listAgents, no new row", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_RETIRE,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(!isErr(createEnv));
    const agentId = createEnv.result.data.agentId;

    const beforeCount = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_RETIRE}`
    )[0]?.c;
    assert.equal(beforeCount, 1);

    const retireEnv = await trpcMutation<{ agentId: string; retiredAt: string }>(
      "retireFollowUpAgent",
      { agentId },
    );
    assert.ok(!isErr(retireEnv), `retire should succeed: ${JSON.stringify(retireEnv)}`);
    assert.equal(retireEnv.result.data.agentId, agentId);

    const [row] = await poolSql<{ retired_at: Date | null }[]>`
      SELECT retired_at FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.ok(row?.retired_at, "retired_at set");

    // No new row created.
    const afterCount = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_RETIRE}`
    )[0]?.c;
    assert.equal(afterCount, 1, "retire never inserts a new row");

    // listAgents excludes retired.
    const listEnv = await trpcQuery<{
      agents: Array<{ id: string; name: string }>;
    }>("listAgents");
    assert.ok(!isErr(listEnv));
    const inList = listEnv.result.data.agents.find((a) => a.name === NAME_RETIRE);
    assert.equal(inList, undefined, "retired agent absent from listAgents");

    // Double-retire returns BAD_REQUEST.
    const retireAgain = await trpcMutation("retireFollowUpAgent", { agentId });
    assert.ok(isErr(retireAgain));
    assert.equal(retireAgain.error.data.code, "BAD_REQUEST");
  });

  it("Test 3: toggle flips enabled, no new version row, re-enable round-trips", async () => {
    const createEnv = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_TOGGLE,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "friendly",
      max_tokens: 200,
    });
    assert.ok(!isErr(createEnv));
    const agentId = createEnv.result.data.agentId;

    const [initial] = await poolSql<{ enabled: boolean; version: number }[]>`
      SELECT enabled, version FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(initial?.enabled, true);
    assert.equal(initial?.version, 1);

    // Disable.
    const disableEnv = await trpcMutation<{ agentId: string; enabled: boolean }>(
      "toggleFollowUpAgent",
      { agentId, enabled: false },
    );
    assert.ok(!isErr(disableEnv), `disable should succeed: ${JSON.stringify(disableEnv)}`);
    assert.equal(disableEnv.result.data.enabled, false);

    const [afterDisable] = await poolSql<{ enabled: boolean; version: number }[]>`
      SELECT enabled, version FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(afterDisable?.enabled, false);
    assert.equal(afterDisable?.version, 1, "toggle does NOT bump version");

    // Row count unchanged — no new version row inserted.
    const count = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_TOGGLE}`
    )[0]?.c;
    assert.equal(count, 1);

    // Re-enable.
    const enableEnv = await trpcMutation<{ agentId: string; enabled: boolean }>(
      "toggleFollowUpAgent",
      { agentId, enabled: true },
    );
    assert.ok(!isErr(enableEnv));
    assert.equal(enableEnv.result.data.enabled, true);

    const [afterEnable] = await poolSql<{ enabled: boolean }[]>`
      SELECT enabled FROM public.automation_agents WHERE id = ${agentId}
    `;
    assert.equal(afterEnable?.enabled, true);

    // Disabled+retired is rejected (we test only on active rows).
    await poolSql`UPDATE public.automation_agents SET retired_at = now() WHERE id = ${agentId}`;
    const toggleRetired = await trpcMutation("toggleFollowUpAgent", { agentId, enabled: false });
    assert.ok(isErr(toggleRetired));
    assert.equal(toggleRetired.error.data.code, "BAD_REQUEST");
  });

  it("Test 4: #102 retrofit — duplicate active name returns clean BAD_REQUEST, no second row", async () => {
    const first = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_DUP,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "neutral",
      max_tokens: 200,
    });
    assert.ok(!isErr(first), `first create should succeed: ${JSON.stringify(first)}`);

    const second = await trpcMutation("createFollowUpAgent", {
      name: NAME_DUP,
      days_threshold: 7,
      stage: "hr_round",
      tone: "formal",
      max_tokens: 150,
    });
    assert.ok(isErr(second), `second create should fail: ${JSON.stringify(second)}`);
    assert.equal(
      second.error.data.code,
      "BAD_REQUEST",
      "ON CONFLICT DO NOTHING path returns BAD_REQUEST, not INTERNAL",
    );

    // Exactly one row exists — the retrofit's empty-RETURNING path
    // means the duplicate INSERT was a no-op (no row inserted then
    // rolled back).
    const count = (
      await poolSql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM public.automation_agents WHERE name = ${NAME_DUP}`
    )[0]?.c;
    assert.equal(count, 1, "duplicate INSERT was a no-op, not a rolled-back row");
  });

  it("Test 5: successive edits advance the version counter; lineage by (tenant, name) returns full history", async () => {
    const v1 = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
      name: NAME_MULTIEDIT,
      days_threshold: 5,
      stage: "tech_screen",
      tone: "friendly",
      max_tokens: 200,
    });
    assert.ok(!isErr(v1));
    const v1Id = v1.result.data.agentId;

    const v2 = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateFollowUpAgent", { agentId: v1Id, tone: "neutral" });
    assert.ok(!isErr(v2));
    assert.equal(v2.result.data.version, 2);
    const v2Id = v2.result.data.agentId;

    const v3 = await trpcMutation<{
      agentId: string;
      previousAgentId: string;
      version: number;
    }>("updateFollowUpAgent", { agentId: v2Id, days_threshold: 11 });
    assert.ok(!isErr(v3));
    assert.equal(v3.result.data.version, 3, "version counter advances per edit");
    assert.equal(v3.result.data.previousAgentId, v2Id);
    const v3Id = v3.result.data.agentId;

    // Name-anchored lineage query returns all three versions.
    const lineage = await poolSql<{
      id: string;
      version: number;
      retired_at: Date | null;
    }[]>`
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
