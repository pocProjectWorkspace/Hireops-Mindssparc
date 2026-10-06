import { describe, it, expect, vi } from "vitest";
import {
  ASK_DATA_CATALOG,
  ASK_DATA_INTENT_IDS,
  askDataInputSchema,
  askDataOutputSchema,
} from "@hireops/api-types";

// The executors read the shared DB; the orchestrator tests below replace them
// with a stub so this file never needs a connection.
vi.mock("../src/lib/ask-data/execute", () => ({
  executeAskDataIntent: vi.fn(async (intent: string) => ({
    title: intent,
    kind: "kpi",
    columns: [],
    rows: [],
    summary: "stub",
    footnote: "stub",
    empty: true,
  })),
  loadAskDataLookups: vi.fn(),
}));

import {
  ASK_DATA_AI_UNAVAILABLE_MESSAGE,
  HIRING_MANAGER_SCOPE,
  applyIntentParams,
  askDataAiResponseSchema,
  buildAskDataPrompt,
  buildChips,
  interpretQuestion,
  matchByName,
  mergeFollowUp,
  normalizeQuestion,
  parseFollowUp,
  preMatchQuestion,
  resolvePeriodWindow,
  suggestQuestions,
  validateParams,
  type AskDataLookups,
} from "../src/lib/ask-data/interpret";
import { runAskData, ASK_DATA_ROLE_UNAVAILABLE_MESSAGE } from "../src/lib/ask-data/run";
import { executeAskDataIntent } from "../src/lib/ask-data/execute";

/**
 * ASK-DATA pure units. The honesty guarantees (whitelist-only intents, no
 * invented names, no model on chip clicks, role scoping never widening to
 * tenant-wide) live in pure helpers, so they are testable without a model or
 * the shared DB. The AI call is injected, so every branch is driven by a mock.
 */

const lookups: AskDataLookups = {
  businessUnits: [
    { id: "bu-fin", name: "Finance" },
    { id: "bu-proc", name: "Procurement & Sourcing" },
    { id: "bu-hr", name: "Human Resources" },
  ],
  requisitions: [
    { id: "req-1", name: "Senior Accountant" },
    { id: "req-2", name: "Accounts Payable Analyst" },
  ],
};

const NOW = new Date("2026-10-08T10:00:00.000Z");

const neverCalled = vi.fn(async () => {
  throw new Error("the model must not be called");
});

describe("ask-data: catalog + schemas", () => {
  it("has exactly the 14 whitelisted intents, each with a catalog entry", () => {
    expect(ASK_DATA_INTENT_IDS).toHaveLength(14);
    expect(ASK_DATA_CATALOG.map((e) => e.id).sort()).toEqual([...ASK_DATA_INTENT_IDS].sort());
    for (const id of ASK_DATA_INTENT_IDS) expect(HIRING_MANAGER_SCOPE[id]).toBeDefined();
  });

  it("the AI response schema only admits catalog intents or 'unsupported'", () => {
    expect(
      askDataAiResponseSchema.safeParse({ intent: "time_to_fill", confidence: "high" }).success,
    ).toBe(true);
    expect(
      askDataAiResponseSchema.safeParse({ intent: "unsupported", confidence: "high" }).success,
    ).toBe(true);
    expect(
      askDataAiResponseSchema.safeParse({ intent: "run_sql", confidence: "high" }).success,
    ).toBe(false);
    // No numeric answer field exists for the model to fill.
    const parsed = askDataAiResponseSchema.parse({
      intent: "time_to_fill",
      confidence: "high",
      answer: 42,
    });
    expect("answer" in parsed).toBe(false);
  });

  it("askData input requires a question or an intent and rejects bad params", () => {
    expect(askDataInputSchema.safeParse({}).success).toBe(false);
    expect(askDataInputSchema.safeParse({ intent: "time_to_fill" }).success).toBe(true);
    expect(askDataInputSchema.safeParse({ question: "hi" }).success).toBe(true);
    expect(
      askDataInputSchema.safeParse({ intent: "time_to_fill_trend", params: { months: 99 } })
        .success,
    ).toBe(false);
    expect(askDataInputSchema.safeParse({ intent: "nope" }).success).toBe(false);
  });
});

describe("ask-data: deterministic pre-matcher", () => {
  it("matches every suggested question exactly", () => {
    for (const e of ASK_DATA_CATALOG) expect(preMatchQuestion(e.question)).toBe(e.id);
  });

  it("matches near-exact variants (case, punctuation, small typos)", () => {
    expect(preMatchQuestion("what is our average time to fill")).toBe("time_to_fill");
    expect(preMatchQuestion("  WHERE are our hires coming from??")).toBe("hires_by_source");
    expect(preMatchQuestion("Which offers were declined and why")).toBe("declined_offers");
    expect(preMatchQuestion("Who is joining in the next 30 days")).toBe("joiners_next_30_days");
    expect(preMatchQuestion("Where are candidates geting stuck?")).toBe("stage_bottlenecks");
  });

  it("matches a chip label", () => {
    expect(preMatchQuestion("Offer acceptance rate")).toBe("offer_acceptance");
  });

  it("does not match unrelated or merely similar-topic questions", () => {
    expect(preMatchQuestion("What is the weather today?")).toBeNull();
    expect(preMatchQuestion("What is our average salary for accountants?")).toBeNull();
    expect(preMatchQuestion("")).toBeNull();
  });

  it("normalises punctuation, apostrophes and ampersands", () => {
    expect(normalizeQuestion("  Who's  joining — R&D? ")).toBe("whos joining r and d");
  });
});

describe("ask-data: periods", () => {
  it("resolves calendar windows in UTC", () => {
    expect(resolvePeriodWindow("this_month", NOW)).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: NOW.toISOString(),
    });
    expect(resolvePeriodWindow("last_month", NOW)).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T23:59:59.999Z",
    });
    expect(resolvePeriodWindow("last_quarter", NOW)).toEqual({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-09-30T23:59:59.999Z",
    });
    expect(resolvePeriodWindow("this_quarter", NOW).from).toBe("2026-10-01T00:00:00.000Z");
    expect(resolvePeriodWindow("this_year", NOW).from).toBe("2026-01-01T00:00:00.000Z");
    expect(resolvePeriodWindow("all_time", NOW)).toEqual({});
  });

  it("last quarter wraps the year in Q1", () => {
    expect(resolvePeriodWindow("last_quarter", new Date("2026-02-10T00:00:00Z"))).toEqual({
      from: "2025-10-01T00:00:00.000Z",
      to: "2025-12-31T23:59:59.999Z",
    });
  });
});

describe("ask-data: param validator", () => {
  it("drops params an intent does not honour, and fills defaults", () => {
    const r = applyIntentParams("pending_approvals", {
      period: "last_month",
      businessUnit: "Finance",
    });
    expect(r.params).toEqual({});
    expect(r.dropped.sort()).toEqual(["businessUnit", "period"]);
    expect(applyIntentParams("time_to_fill", {}).params).toEqual({ period: "this_year" });
    expect(applyIntentParams("time_to_fill_trend", {}).params).toEqual({ months: 6 });
  });

  it("resolves business-unit and requisition names to the tenant's real ids", () => {
    const v = validateParams(
      { period: "last_quarter", businessUnit: "finance", requisition: "senior accountant" },
      lookups,
      NOW,
    );
    expect(v.filters.businessUnitId).toBe("bu-fin");
    expect(v.filters.requisitionId).toBe("req-1");
    expect(v.params.businessUnit).toBe("Finance");
    expect(v.filters.window.from).toBe("2026-07-01T00:00:00.000Z");
    expect(v.notes).toEqual([]);
  });

  it("drops (with a note) names that do not resolve — never guesses", () => {
    const v = validateParams(
      { businessUnit: "Marketing", requisition: "Payroll Manager" },
      lookups,
      NOW,
    );
    expect(v.filters.businessUnitId).toBeUndefined();
    expect(v.params.businessUnit).toBeUndefined();
    expect(v.filters.requisitionId).toBeUndefined();
    expect(v.notes).toHaveLength(2);
    expect(v.notes[0]).toMatch(/No business unit called "Marketing"/);
    expect(v.notes[1]).toMatch(/No open requisition matching "Payroll Manager"/);
  });

  it("matchByName: unique containment matches, duplicates are ambiguous", () => {
    expect(matchByName("procurement", lookups.businessUnits)).toMatchObject({ kind: "match" });
    expect(
      matchByName("Ops", [
        { id: "a", name: "Ops" },
        { id: "b", name: "Ops" },
      ]),
    ).toEqual({ kind: "ambiguous", count: 2 });
    expect(matchByName("zzz", lookups.businessUnits)).toEqual({ kind: "none" });
  });

  it("builds the interpretation chips", () => {
    const chips = buildChips("time_to_fill", { period: "last_quarter", businessUnit: "Finance" });
    expect(chips.map((c) => c.value)).toEqual(["Time to fill", "Last quarter", "Finance"]);
    expect(buildChips("open_reqs_by_bu", {}).map((c) => c.value)).toEqual([
      "Open requisitions by business unit",
      "All business units",
    ]);
  });
});

describe("ask-data: follow-up merge", () => {
  const previous = {
    intent: "time_to_fill" as const,
    params: { period: "this_year" as const, businessUnit: "Human Resources" },
  };

  it("mergeFollowUp overlays set values and clears widened filters", () => {
    expect(mergeFollowUp(previous.params, { set: { period: "last_quarter" }, clear: [] })).toEqual({
      period: "last_quarter",
      businessUnit: "Human Resources",
    });
    expect(mergeFollowUp(previous.params, { set: {}, clear: ["businessUnit"] })).toEqual({
      period: "this_year",
    });
  });

  it("parses 'now only Finance' and 'same for last quarter' without the model", () => {
    expect(parseFollowUp("now only Finance", previous, lookups.businessUnits)).toEqual({
      set: { businessUnit: "Finance" },
      clear: [],
    });
    expect(parseFollowUp("Same for last quarter", previous, lookups.businessUnits)).toEqual({
      set: { period: "last_quarter" },
      clear: [],
    });
    expect(
      parseFollowUp("what about procurement this month?", previous, lookups.businessUnits),
    ).toEqual({
      set: { period: "this_month", businessUnit: "Procurement & Sourcing" },
      clear: [],
    });
    expect(parseFollowUp("show all business units", previous, lookups.businessUnits)).toEqual({
      set: {},
      clear: ["businessUnit"],
    });
  });

  it("reads 'last 12 months' as a months count only for the trend", () => {
    const trend = { intent: "time_to_fill_trend" as const, params: { months: 6 } };
    expect(parseFollowUp("last 12 months", trend, lookups.businessUnits)).toEqual({
      set: { months: 12 },
      clear: [],
    });
    expect(parseFollowUp("last 3 months", previous, lookups.businessUnits)?.set).toEqual({
      period: "last_90_days",
    });
  });

  it("returns null for anything that is not a pure filter change", () => {
    expect(
      parseFollowUp("how many offers were declined", previous, lookups.businessUnits),
    ).toBeNull();
    expect(parseFollowUp("only Marketing", previous, lookups.businessUnits)).toBeNull();
    expect(parseFollowUp("", previous, lookups.businessUnits)).toBeNull();
  });
});

describe("ask-data: interpretQuestion (AI path mocked)", () => {
  it("resolves a suggested question without calling the model", async () => {
    const out = await interpretQuestion({
      question: "What is our offer acceptance rate?",
      lookups,
      aiEnabled: true,
      complete: neverCalled,
    });
    expect(out).toMatchObject({
      status: "resolved",
      intent: "offer_acceptance",
      source: "matched",
    });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("merges a deterministic follow-up onto the previous answer", async () => {
    const out = await interpretQuestion({
      question: "now only Finance",
      previous: { intent: "time_to_fill", params: { period: "last_quarter" } },
      lookups,
      aiEnabled: false,
      complete: neverCalled,
    });
    expect(out).toMatchObject({
      status: "resolved",
      intent: "time_to_fill",
      params: { period: "last_quarter", businessUnit: "Finance" },
    });
  });

  it("uses the model for free text and keeps only whitelisted output", async () => {
    const complete = vi.fn(async () => ({
      intent: "hires_by_source",
      confidence: "high",
      period: "last_quarter",
      businessUnit: "Finance",
    }));
    const out = await interpretQuestion({
      question: "which channels gave us finance hires last quarter",
      lookups,
      aiEnabled: true,
      complete,
      now: NOW,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(out).toMatchObject({
      status: "resolved",
      intent: "hires_by_source",
      source: "ai",
      params: { period: "last_quarter", businessUnit: "Finance" },
    });
  });

  it("treats 'unsupported', low confidence and malformed output honestly", async () => {
    const unsupported = await interpretQuestion({
      question: "who should we hire",
      lookups,
      aiEnabled: true,
      complete: async () => ({ intent: "unsupported", confidence: "high" }),
    });
    expect(unsupported.status).toBe("unsupported");

    const low = await interpretQuestion({
      question: "something vague",
      lookups,
      aiEnabled: true,
      complete: async () => ({ intent: "time_to_fill", confidence: "low" }),
    });
    expect(low).toMatchObject({ status: "unsupported", bestGuess: "time_to_fill" });

    const bad = await interpretQuestion({
      question: "something vague",
      lookups,
      aiEnabled: true,
      complete: async () => ({ intent: "drop_table", confidence: "high" }),
    });
    expect(bad.status).toBe("ai_unavailable");
  });

  it("degrades when the feature is off or the provider throws", async () => {
    const off = await interpretQuestion({
      question: "tell me something interesting",
      lookups,
      aiEnabled: false,
      complete: neverCalled,
    });
    expect(off).toEqual({ status: "ai_unavailable", message: ASK_DATA_AI_UNAVAILABLE_MESSAGE });

    const failing = await interpretQuestion({
      question: "tell me something interesting",
      lookups,
      aiEnabled: true,
      complete: async () => {
        throw new Error("provider down");
      },
    });
    expect(failing.status).toBe("ai_unavailable");
  });

  it("the prompt carries the whitelist and the tenant's real names, fenced as data", () => {
    const { system, user } = buildAskDataPrompt({ question: "x", lookups, today: NOW });
    for (const id of ASK_DATA_INTENT_IDS) expect(system).toContain(`- ${id}:`);
    expect(system).toMatch(/never compute or estimate a number/i);
    expect(user).toContain("- Procurement & Sourcing");
    expect(user).toContain("- Senior Accountant");
    expect(user).toContain("Question: <<<x>>>");
  });

  it("suggests three catalog questions", () => {
    const s = suggestQuestions("offers declined reasons");
    expect(s).toHaveLength(3);
    expect(s[0]?.intent).toBe("declined_offers");
  });
});

describe("ask-data: runAskData orchestration", () => {
  const exec = {
    db: {} as never,
    tenantId: "t",
    resolveNames: async () => new Map(),
    canSeeCandidateNames: true,
    hmMembershipId: null,
    hmRequisitionIds: null,
  };

  it("chip path executes directly with no model call and returns editable chips", async () => {
    const out = await runAskData({
      input: {
        intent: "time_to_fill",
        params: { period: "last_quarter", businessUnit: "Finance" },
      },
      lookups,
      exec,
      aiEnabled: true,
      complete: neverCalled,
      now: NOW,
    });
    expect(askDataOutputSchema.safeParse(out).success).toBe(true);
    expect(out.status).toBe("answered");
    expect(out.interpretation?.source).toBe("chip");
    expect(out.interpretation?.params).toEqual({ period: "last_quarter", businessUnit: "Finance" });
    expect(neverCalled).not.toHaveBeenCalled();
    expect(executeAskDataIntent).toHaveBeenLastCalledWith(
      "time_to_fill",
      exec,
      expect.objectContaining({ businessUnitId: "bu-fin", period: "last_quarter" }),
    );
  });

  it("notes an explicitly requested param the intent ignores", async () => {
    const out = await runAskData({
      input: { intent: "pending_approvals", params: { period: "last_month" } },
      lookups,
      exec,
      aiEnabled: false,
      complete: neverCalled,
    });
    expect(out.interpretation?.notes[0]).toMatch(/doesn't apply/);
  });

  it("unsupported returns three suggestions and no result", async () => {
    const out = await runAskData({
      input: { question: "predict next year's attrition" },
      lookups,
      exec,
      aiEnabled: true,
      complete: async () => ({ intent: "unsupported", confidence: "high" }),
    });
    expect(out.status).toBe("unsupported");
    expect(out.result).toBeUndefined();
    expect(out.suggestions).toHaveLength(3);
  });

  it("hiring manager: unscoped intents are unavailable, never tenant-wide", async () => {
    vi.mocked(executeAskDataIntent).mockClear();
    const hm = { ...exec, hmMembershipId: "m-1", hmRequisitionIds: new Set(["req-1"]) };
    const out = await runAskData({
      input: { intent: "recruiter_activity" },
      lookups,
      exec: hm,
      aiEnabled: false,
      complete: neverCalled,
    });
    expect(out.status).toBe("unavailable");
    expect(out.message).toBe(ASK_DATA_ROLE_UNAVAILABLE_MESSAGE);
    expect(executeAskDataIntent).not.toHaveBeenCalled();
  });

  it("hiring manager: requisition-scoped intents need one own requisition", async () => {
    vi.mocked(executeAskDataIntent).mockClear();
    const hm = { ...exec, hmMembershipId: "m-1", hmRequisitionIds: new Set(["req-1", "req-2"]) };
    const many = await runAskData({
      input: { intent: "time_to_fill" },
      lookups,
      exec: hm,
      aiEnabled: false,
      complete: neverCalled,
    });
    expect(many.status).toBe("unavailable");
    expect(executeAskDataIntent).not.toHaveBeenCalled();

    const one = await runAskData({
      input: { intent: "time_to_fill" },
      lookups: { ...lookups, requisitions: [{ id: "req-1", name: "Senior Accountant" }] },
      exec: hm,
      aiEnabled: false,
      complete: neverCalled,
    });
    expect(one.status).toBe("answered");
    expect(one.interpretation?.params.requisition).toBe("Senior Accountant");
    expect(executeAskDataIntent).toHaveBeenLastCalledWith(
      "time_to_fill",
      hm,
      expect.objectContaining({ requisitionId: "req-1" }),
    );
  });
});
