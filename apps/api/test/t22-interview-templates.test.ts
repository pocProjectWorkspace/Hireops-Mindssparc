/**
 * T2.2 / G07 — tenant interview ROUND templates + CUSTOM scorecard VALUES.
 *
 * Exercises the config procedures over real cloud-minted JWTs (reality #110):
 *
 *   Test 1: round templates — upsertInterviewRoundTemplate (admin) replace-sets
 *           the tenant's default loop; listInterviewRoundTemplates reads it back;
 *           re-upsert replaces in place (replace-set, not append).
 *   Test 2: custom scorecards — upsertScorecardTemplate (admin) saves a custom
 *           rubric; listScorecardTemplates returns it in `custom` and in `options`
 *           (isCustom=true) alongside the 4 code defaults (isCustom=false).
 *   Test 3: HONESTY — the scorecard value set is tenant-EXTENSIBLE, not unbounded.
 *           A round naming an UNKNOWN scorecard key is REJECTED at write; a round
 *           naming a saved custom key (or a code default) is ACCEPTED. Reserved
 *           code-default keys ('technical' …) cannot be re-defined as custom.
 *   Test 4: gating — interview templates are admin-only; recruiter is FORBIDDEN
 *           on read AND write.
 *
 * ENFORCEMENT NOTE: the membership guard ({4 code defaults} ∪ {tenant custom keys})
 * is enforced server-side at write in upsertInterviewRoundTemplate + upsertInterview
 * Plan + applyInterviewRoundTemplate (the DB CHECK was relaxed to a lax snake_case
 * shape, 0102). Applying a loop to a live requisition (applied:true) + the
 * criteria-snapshot immutability are covered by the plan/scorecard render path;
 * a full requisition-fixture integration test is a follow-up. TENANT ISOLATION is
 * enforced by both new tables' FORCE ROW LEVEL SECURITY + tenant_isolation policy,
 * verified at migration.
 *
 * Captures the tenant's CURRENT loop in beforeAll and RESTORES it in afterAll, and
 * owns the throwaway scorecard key `t22_probe_card` (deleted in afterAll), so the
 * t22 seed / demo config is never clobbered.
 *
 * Requires `pnpm db:seed:test-users` (admin1 / recruiter1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";

const PROBE_KEY = "t22_probe_card";

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}
async function q<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function m<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface RoundRow {
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  mode: string;
  scorecardTemplateKey: string;
  competencyFocus: string[];
}
interface RoundsOut {
  rounds: RoundRow[];
  roundCount?: number;
}
interface ScorecardOpt {
  scorecardKey: string;
  label: string;
  criteria: { key: string; label: string }[];
  isCustom: boolean;
}
interface ScorecardsOut {
  custom: { scorecardKey: string; label: string; criteria: { key: string; label: string }[] }[];
  options: ScorecardOpt[];
}

let adminJwt: string;
let recruiterJwt: string;
let savedRounds: RoundRow[] = [];

describe("T2.2 / G07 interview round + scorecard templates", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    const cur = await q<RoundsOut>("listInterviewRoundTemplates", {}, adminJwt);
    if (!isErr(cur)) savedRounds = cur.result.data.rounds ?? [];
  });

  afterAll(async () => {
    // Restore the tenant's original loop FIRST (drops any probe reference), then
    // delete the throwaway custom scorecard.
    try {
      await m("upsertInterviewRoundTemplate", { rounds: savedRounds }, adminJwt);
    } catch {
      // best-effort
    }
    try {
      await m("deleteScorecardTemplate", { scorecardKey: PROBE_KEY }, adminJwt);
    } catch {
      // best-effort
    }
  });

  it("Test 1: upsertInterviewRoundTemplate replace-sets the loop; list reads it back", async () => {
    const loop = {
      rounds: [
        {
          roundNumber: 1,
          roundName: "T22 Screen",
          durationMinutes: 45,
          mode: "phone",
          scorecardTemplateKey: "general",
          competencyFocus: ["communication"],
        },
        {
          roundNumber: 2,
          roundName: "T22 Technical",
          durationMinutes: 60,
          mode: "video",
          scorecardTemplateKey: "technical",
          competencyFocus: ["system_design"],
        },
      ],
    };
    const up = await m<RoundsOut>("upsertInterviewRoundTemplate", loop, adminJwt);
    assert.ok(!isErr(up), `upsert loop (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.roundCount, 2, "two rounds saved");

    const list = await q<RoundsOut>("listInterviewRoundTemplates", {}, adminJwt);
    assert.ok(!isErr(list));
    assert.equal(list.result.data.rounds.length, 2, "loop read back");
    assert.deepEqual(
      list.result.data.rounds.map((r) => r.roundName),
      ["T22 Screen", "T22 Technical"],
      "ordered rounds",
    );

    // Replace-set: a single-round upsert REPLACES the loop (not append).
    const replace = await m<RoundsOut>(
      "upsertInterviewRoundTemplate",
      { rounds: [loop.rounds[0]] },
      adminJwt,
    );
    assert.ok(!isErr(replace));
    assert.equal(replace.result.data.roundCount, 1, "replace-set → 1 round");
  });

  it("Test 2: upsertScorecardTemplate saves a custom rubric; list surfaces it in options", async () => {
    const up = await m<{ row: { scorecardKey: string } }>(
      "upsertScorecardTemplate",
      {
        scorecardKey: PROBE_KEY,
        label: "T22 Probe Rubric",
        criteria: [
          { key: "depth", label: "Technical Depth" },
          { key: "ownership", label: "Ownership" },
        ],
      },
      adminJwt,
    );
    assert.ok(!isErr(up), `upsert scorecard (admin): ${JSON.stringify(up)}`);

    const list = await q<ScorecardsOut>("listScorecardTemplates", {}, adminJwt);
    assert.ok(!isErr(list));
    const custom = list.result.data.custom.find((c) => c.scorecardKey === PROBE_KEY);
    assert.ok(custom, "custom rubric listed");
    assert.equal(custom!.criteria.length, 2, "criteria persisted");
    const opt = list.result.data.options.find((o) => o.scorecardKey === PROBE_KEY);
    assert.ok(opt && opt.isCustom, "custom rubric in options with isCustom=true");
    // The 4 code defaults are still selectable (isCustom=false).
    for (const def of ["technical", "manager", "hr", "general"]) {
      const o = list.result.data.options.find((x) => x.scorecardKey === def);
      assert.ok(o && !o.isCustom, `default '${def}' selectable, isCustom=false`);
    }
  });

  it("Test 3: honesty — unknown scorecard key rejected; custom key accepted; reserved key blocked", async () => {
    const oneRound = (key: string) => ({
      rounds: [
        {
          roundNumber: 1,
          roundName: "Probe",
          durationMinutes: 45,
          mode: "video",
          scorecardTemplateKey: key,
          competencyFocus: [],
        },
      ],
    });

    // Unknown key → rejected server-side (not in {4 defaults} ∪ {tenant keys}).
    const bad = await m("upsertInterviewRoundTemplate", oneRound("no_such_scorecard"), adminJwt);
    assert.ok(isErr(bad), "round naming an unknown scorecard is rejected");

    // Saved custom key → accepted (proves the set is {defaults} ∪ {tenant keys}).
    const good = await m<RoundsOut>("upsertInterviewRoundTemplate", oneRound(PROBE_KEY), adminJwt);
    assert.ok(
      !isErr(good),
      `round naming the saved custom scorecard accepted: ${JSON.stringify(good)}`,
    );

    // Reserved code-default key cannot be redefined as a custom rubric.
    const reserved = await m(
      "upsertScorecardTemplate",
      { scorecardKey: "technical", label: "Hijack", criteria: [{ key: "x", label: "X" }] },
      adminJwt,
    );
    assert.ok(isErr(reserved), "a reserved code-default scorecard key cannot be re-defined");
  });

  it("Test 4: gating — interview templates are admin-only (recruiter FORBIDDEN read + write)", async () => {
    const read = await q("listScorecardTemplates", {}, recruiterJwt);
    assert.ok(isErr(read) && read.error.data.code === "FORBIDDEN", "recruiter FORBIDDEN on read");
    const writeRounds = await m("upsertInterviewRoundTemplate", { rounds: [] }, recruiterJwt);
    assert.ok(
      isErr(writeRounds) && writeRounds.error.data.code === "FORBIDDEN",
      "recruiter FORBIDDEN on round-template write",
    );
    const writeCard = await m(
      "upsertScorecardTemplate",
      { scorecardKey: "recruiter_probe", label: "X", criteria: [{ key: "a", label: "A" }] },
      recruiterJwt,
    );
    assert.ok(
      isErr(writeCard) && writeCard.error.data.code === "FORBIDDEN",
      "recruiter FORBIDDEN on scorecard write",
    );
  });
});
