/**
 * PC-21 — the Ask-your-data question log. Pure: role filtering, text
 * normalisation, recent de-dup, popular ranking. SQL: the log + popular
 * ranking role scoping + RLS (tenant isolation, append-only) against a
 * THROWAWAY LOCAL Postgres only with migration 0131 applied — skipped
 * otherwise (see local-pg-fixture.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { askDataCatalogEntry } from "@hireops/api-types";

import {
  askerRolesFor,
  dedupeRecent,
  loadPopularIntents,
  loadRecentQuestions,
  loadTopQuestions,
  logAskDataQuestion,
  normaliseQuestionText,
  rankPopularIntents,
  textArrayLiteral,
} from "../src/lib/ask-data/question-log";
import { HAS_LOCAL_PG, loadLocalDb, prepareLocalSchema } from "./local-pg-fixture";

const ASK_ROLES = new Set(["admin", "hr_head", "hr_ops", "recruiter", "hiring_manager"]);

describe("PC-21 pure helpers", () => {
  it("askerRolesFor keeps only Ask-your-data roles, deduped + sorted", () => {
    expect(askerRolesFor(["panel_member", "recruiter", "admin", "recruiter"], ASK_ROLES)).toEqual([
      "admin",
      "recruiter",
    ]);
    expect(askerRolesFor(["panel_member"], ASK_ROLES)).toEqual([]);
  });

  it("normaliseQuestionText trims, collapses whitespace, caps at 500, null for blank", () => {
    expect(normaliseQuestionText("  time   to\nfill ")).toBe("time to fill");
    expect(normaliseQuestionText("   ")).toBeNull();
    expect(normaliseQuestionText(null)).toBeNull();
    expect(normaliseQuestionText("x".repeat(600))).toHaveLength(500);
  });

  it("textArrayLiteral strips quote / backslash injection", () => {
    expect(textArrayLiteral(["a", 'b"},{"admin'])).toBe('{"a","b},{admin"}');
  });

  it("dedupeRecent keeps the newest of each (intent, params), labels chip clicks with the catalog question", () => {
    const rows = [
      {
        question: null,
        intent: "time_to_fill",
        params: { period: "this_month" },
        created_at: "2026-11-10T10:00:00Z",
      },
      {
        question: "ttf?",
        intent: "time_to_fill",
        params: { period: "this_month" },
        created_at: "2026-11-09T10:00:00Z",
      },
      {
        question: "old one",
        intent: "time_to_fill",
        params: { period: "last_month" },
        created_at: "2026-11-08T10:00:00Z",
      },
      {
        question: "gone",
        intent: "retired_intent",
        params: {},
        created_at: "2026-11-07T10:00:00Z",
      },
      {
        question: "bad",
        intent: "time_to_fill",
        params: { months: 999 },
        created_at: "2026-11-06T10:00:00Z",
      },
    ];
    const out = dedupeRecent(rows, 6);
    expect(out.map((r) => r.label)).toEqual([
      askDataCatalogEntry("time_to_fill").question,
      "old one",
    ]);
  });

  it("rankPopularIntents: most asked first, catalog order on ties, drops intents the caller can't run", () => {
    const out = rankPopularIntents(
      [
        { intent: "time_to_fill", count: 3 },
        { intent: "open_reqs_by_bu", count: 3 },
        { intent: "recruiter_activity", count: 9 },
        { intent: "declined_offers", count: 1 },
        { intent: "not_an_intent", count: 50 },
      ],
      (i) => i !== "recruiter_activity",
    );
    expect(out.map((p) => p.intent)).toEqual([
      "open_reqs_by_bu",
      "time_to_fill",
      "declined_offers",
    ]);
    expect(out[0]?.label).toBe(askDataCatalogEntry("open_reqs_by_bu").question);
  });
});

describe.skipIf(!HAS_LOCAL_PG)("PC-21 question log (local Postgres, migration 0131)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const recruiter1 = randomUUID();
  const recruiter2 = randomUUID();
  const hrHead = randomUUID();
  const hm = randomUUID();
  const otherTenantMember = randomUUID();
  let mod: Awaited<ReturnType<typeof loadLocalDb>>;

  type Db = Parameters<Parameters<typeof mod.withTenantContext>[1]>[0]["db"];
  const asTenant = <R>(tid: string, fn: (db: Db) => Promise<R>) =>
    mod.withTenantContext({ sub: randomUUID(), tid, roles: ["recruiter"] }, ({ db }) => fn(db));

  beforeAll(async () => {
    mod = await loadLocalDb();
    await prepareLocalSchema(mod);
    const { sql } = mod;
    await sql`INSERT INTO public.tenants (id) VALUES (${tenantA}), (${tenantB})`;
    await sql`INSERT INTO public.tenant_user_memberships (id, tenant_id) VALUES
      (${recruiter1}, ${tenantA}), (${recruiter2}, ${tenantA}), (${hrHead}, ${tenantA}),
      (${hm}, ${tenantA}), (${otherTenantMember}, ${tenantB})`;

    const log = (
      tid: string,
      membershipId: string,
      roles: string[],
      intent: string,
      question: string | null,
      params = {},
    ) =>
      asTenant(tid, (db) =>
        logAskDataQuestion(db, {
          tenantId: tid,
          membershipId,
          roles,
          question,
          intent: intent as never,
          params,
          source: question ? "ai" : "chip",
        }),
      );
    // Recruiters: time_to_fill ×3, pipeline_funnel ×1.
    await log(tenantA, recruiter1, ["recruiter"], "time_to_fill", "What is our time to fill?");
    await log(tenantA, recruiter1, ["recruiter"], "time_to_fill", null);
    await log(tenantA, recruiter2, ["recruiter"], "time_to_fill", "what  is our time to fill?");
    await log(tenantA, recruiter2, ["recruiter"], "pipeline_funnel", null);
    // HR head: recruiter_activity ×4 (not a recruiter's team).
    for (let i = 0; i < 4; i += 1)
      await log(tenantA, hrHead, ["hr_head"], "recruiter_activity", null);
    // Hiring manager: oldest_open_reqs ×2.
    await log(tenantA, hm, ["hiring_manager"], "oldest_open_reqs", null);
    await log(tenantA, hm, ["hiring_manager"], "oldest_open_reqs", null);
    // Another tenant, a recruiter asking a lot.
    for (let i = 0; i < 5; i += 1)
      await log(tenantB, otherTenantMember, ["recruiter"], "declined_offers", null);
    // An old row outside the 30-day window (direct, superuser — fixture only).
    await sql`INSERT INTO public.ask_data_questions (tenant_id, membership_id, asker_roles, intent, source, created_at)
      VALUES (${tenantA}, ${recruiter1}, '{recruiter}', 'hires_by_source', 'chip', now() - interval '40 days')`;
  });

  afterAll(async () => {
    if (!mod) return;
    await mod.sql`DELETE FROM public.ask_data_questions WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    await mod.sql`DELETE FROM public.tenant_user_memberships WHERE tenant_id IN (${tenantA}, ${tenantB})`;
    await mod.sql`DELETE FROM public.tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await mod.sql.end();
  });

  it("'Popular in your team' is role-scoped: a recruiter sees recruiters' intents only", async () => {
    const out = await asTenant(tenantA, (db) =>
      loadPopularIntents(db, tenantA, { callerRoles: ["recruiter"], canRun: () => true }),
    );
    expect(out.map((p) => [p.intent, p.count])).toEqual([
      ["time_to_fill", 3],
      ["pipeline_funnel", 1],
    ]);
  });

  it("a multi-role caller sees the union of their roles' askers; the 30-day window holds", async () => {
    const out = await asTenant(tenantA, (db) =>
      loadPopularIntents(db, tenantA, {
        callerRoles: ["hr_head", "recruiter"],
        canRun: () => true,
      }),
    );
    expect(out.map((p) => p.intent)).toEqual([
      "recruiter_activity",
      "time_to_fill",
      "pipeline_funnel",
    ]);
    expect(out.find((p) => p.intent === "hires_by_source")).toBeUndefined();
  });

  it("a hiring manager never gets an intent they cannot run, and no role → nothing", async () => {
    const out = await asTenant(tenantA, (db) =>
      loadPopularIntents(db, tenantA, {
        callerRoles: ["hiring_manager"],
        canRun: (i) => i !== "oldest_open_reqs",
      }),
    );
    expect(out).toEqual([]);
    const none = await asTenant(tenantA, (db) =>
      loadPopularIntents(db, tenantA, { callerRoles: [], canRun: () => true }),
    );
    expect(none).toEqual([]);
  });

  it("other tenants' questions never count (explicit predicate + RLS)", async () => {
    // Even asking about tenant B from tenant A's RLS context returns nothing.
    const out = await asTenant(tenantA, (db) =>
      loadPopularIntents(db, tenantB, { callerRoles: ["recruiter"], canRun: () => true }),
    );
    expect(out).toEqual([]);
  });

  it("'Your recent' is the caller's own, newest first, de-duplicated", async () => {
    const out = await asTenant(tenantA, (db) => loadRecentQuestions(db, tenantA, recruiter1));
    expect(out.map((r) => r.intent)).toEqual(["time_to_fill", "hires_by_source"]);
    expect(out[0]?.label).toBe(askDataCatalogEntry("time_to_fill").question); // newest = the chip click
  });

  it("admin top questions group typed text case/space-insensitively", async () => {
    const out = await asTenant(tenantA, (db) => loadTopQuestions(db, tenantA));
    expect(out.questions[0]).toEqual({
      question: "what is our time to fill?",
      intent: "time_to_fill",
      count: 2,
    });
    expect(out.intents.find((i) => i.intent === "time_to_fill")).toMatchObject({
      count: 3,
      askers: 2,
    });
    expect(out.digestSupported).toBe(false);
  });

  it("RLS: append-only — UPDATE / DELETE affect nothing for authenticated", async () => {
    const before =
      await mod.sql`SELECT count(*)::int AS n FROM public.ask_data_questions WHERE tenant_id = ${tenantA}`;
    await asTenant(tenantA, async (db) => {
      await db.execute(
        mod.drizzleSql`UPDATE public.ask_data_questions SET intent = 'x' WHERE tenant_id = ${tenantA}::uuid`,
      );
      await db.execute(
        mod.drizzleSql`DELETE FROM public.ask_data_questions WHERE tenant_id = ${tenantA}::uuid`,
      );
    });
    const after =
      await mod.sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE intent = 'x')::int AS x
      FROM public.ask_data_questions WHERE tenant_id = ${tenantA}`;
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.x).toBe(0);
  });

  it("RLS: cannot insert a row for another tenant", async () => {
    await expect(
      asTenant(tenantA, (db) =>
        logAskDataQuestion(db, {
          tenantId: tenantB,
          membershipId: otherTenantMember,
          roles: ["recruiter"],
          question: null,
          intent: "time_to_fill",
          params: {},
          source: "chip",
        }),
      ),
    ).rejects.toThrow();
  });

  it("FK: cannot log against another tenant's membership", async () => {
    await expect(
      asTenant(tenantA, (db) =>
        logAskDataQuestion(db, {
          tenantId: tenantA,
          membershipId: otherTenantMember,
          roles: ["recruiter"],
          question: null,
          intent: "time_to_fill",
          params: {},
          source: "chip",
        }),
      ),
    ).rejects.toThrow();
  });

  it("FORCE RLS is on for the table", async () => {
    const r =
      await mod.sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ask_data_questions'`;
    expect(r[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
