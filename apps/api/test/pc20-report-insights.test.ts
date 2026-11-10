/**
 * PC-20 — written report insights. Pure: the figure reducers, the number
 * post-check, the cache and the orchestrator with a MOCK model (no network,
 * no DB — the report libs are stubbed so this file never opens a connection).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportFigure } from "@hireops/api-types";

// The report libs (and through them @hireops/db) are never exercised here —
// stub them so the file needs no connection or DATABASE_URL.
vi.mock("../src/lib/reports/approval-analytics", () => ({ getApprovalAnalyticsReport: vi.fn() }));
vi.mock("../src/lib/reports/executive-summary", () => ({ getExecutiveSummaryReport: vi.fn() }));
vi.mock("../src/lib/reports/headcount-vs-plan", () => ({ getHeadcountVsPlanReport: vi.fn() }));
vi.mock("../src/lib/reports/interview-health", () => ({ getInterviewHealthReport: vi.fn() }));
vi.mock("../src/lib/reports/onboarding-readiness", () => ({
  getOnboardingReadinessReport: vi.fn(),
}));
vi.mock("../src/lib/reports/partner-scorecard", () => ({ getPartnerScorecardReport: vi.fn() }));
vi.mock("../src/lib/reports/pipeline-report", () => ({ getPipelineReport: vi.fn() }));
vi.mock("../src/lib/reports/recruiter-productivity", () => ({
  getRecruiterProductivityReport: vi.fn(),
}));
vi.mock("../src/lib/reports/requisition-aging", () => ({ getRequisitionAgingReport: vi.fn() }));

import {
  REPORT_INSIGHTS_CACHE_TTL_MS,
  REPORT_INSIGHTS_MAX,
  REPORT_INSIGHTS_PROMPT_VERSION,
  buildReportInsightsPrompt,
  checkInsightSentence,
  clearReportInsightsCache,
  extractNumbers,
  figuresAreEmpty,
  figuresForPipeline,
  figuresForRecruiterProductivity,
  generateReportInsights,
  insightsCacheKey,
  pctChange,
  postCheckInsights,
} from "../src/lib/reports/insights";

const FIGURES: ReportFigure[] = [
  { key: "median_time_to_fill_days", label: "Median days to fill", value: 41.5, unit: "days" },
  { key: "ttf_change_pct", label: "Change in median days to fill", value: 22, unit: "percent" },
  { key: "hires", label: "Hires", value: 1250, unit: "count" },
  { key: "on_hold", label: "Requisitions on hold", value: 3, unit: "count" },
  { key: "fall_pct", label: "Change in offers", value: -12.5, unit: "percent" },
];

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("PC-20 number post-check", () => {
  it("extracts digits with thousands separators and decimals", () => {
    expect(extractNumbers("Hires reached 1,250 with 41.5 days and 22% up")).toEqual([
      1250, 41.5, 22,
    ]);
  });

  it("keeps a sentence whose every number is a provided figure", () => {
    expect(
      checkInsightSentence(
        {
          text: "Time to fill rose 22% month on month, with 3 requisitions on hold.",
          figureKeys: ["ttf_change_pct", "on_hold"],
        },
        FIGURES,
      ),
    ).toBeNull();
  });

  it("accepts a figure written as a whole number, with separators, or a negative as a fall", () => {
    const ok = (text: string) => checkInsightSentence({ text, figureKeys: ["hires"] }, FIGURES);
    expect(ok("Median time to fill is about 42 days.")).toBeNull(); // 41.5 rounded
    expect(ok("There were 1,250 hires.")).toBeNull();
    expect(ok("Offers fell 12.5%.")).toBeNull(); // |−12.5|
  });

  it("drops a sentence carrying ANY number that is not a figure", () => {
    expect(
      checkInsightSentence(
        { text: "Time to fill rose 23% this month.", figureKeys: ["ttf_change_pct"] },
        FIGURES,
      ),
    ).toBe("unknown_number:23");
    // An invented total / a year / a date are all unknown numbers.
    expect(
      checkInsightSentence(
        { text: "Hires rose 22% in 2026.", figureKeys: ["ttf_change_pct"] },
        FIGURES,
      ),
    ).toBe("unknown_number:2026");
  });

  it("drops spelled-out quantities that would dodge the digit check", () => {
    expect(
      checkInsightSentence(
        { text: "Time to fill nearly doubled.", figureKeys: ["ttf_change_pct"] },
        FIGURES,
      ),
    ).toBe("spelled_out_number");
    expect(
      checkInsightSentence(
        { text: "Three requisitions are on hold.", figureKeys: ["on_hold"] },
        FIGURES,
      ),
    ).toBe("spelled_out_number");
  });

  it("drops a sentence that cites no valid figure key", () => {
    expect(
      checkInsightSentence({ text: "Hiring is going well.", figureKeys: ["made_up"] }, FIGURES),
    ).toBe("no_valid_figure_key");
  });

  it("postCheckInsights keeps passing sentences (max 4), strips unknown keys, counts drops", () => {
    const raw = {
      insights: [
        { text: "Time to fill rose 22%.", figureKeys: ["ttf_change_pct", "bogus"] },
        { text: "Time to fill rose 30%.", figureKeys: ["ttf_change_pct"] },
        { text: "There were 1,250 hires.", figureKeys: ["hires"] },
        { text: "3 requisitions are on hold.", figureKeys: ["on_hold"] },
        { text: "Median time to fill is 41.5 days.", figureKeys: ["median_time_to_fill_days"] },
        { text: "Offers fell 12.5%.", figureKeys: ["fall_pct"] },
      ],
    };
    const out = postCheckInsights(raw, FIGURES);
    expect(out.dropped).toBe(1);
    expect(out.insights).toHaveLength(REPORT_INSIGHTS_MAX);
    expect(out.insights[0]).toEqual({
      text: "Time to fill rose 22%.",
      figureKeys: ["ttf_change_pct"],
    });
    expect(out.insights.map((i) => i.text)).not.toContain("Time to fill rose 30%.");
  });
});

describe("PC-20 figures", () => {
  it("pctChange has no honest base at 0 / null", () => {
    expect(pctChange(0, 5)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(10, 12.2)).toBe(22);
  });

  it("empty or all-zero figures are 'nothing to say'", () => {
    expect(figuresAreEmpty([])).toBe(true);
    expect(figuresAreEmpty([{ key: "a", label: "A", value: 0 }])).toBe(true);
    expect(figuresAreEmpty(FIGURES)).toBe(false);
  });

  it("recruiter productivity figures are aggregates only — no membership ids or names", () => {
    const figs = figuresForRecruiterProductivity([
      {
        recruiterMembershipId: "aaaaaaaa-0000-4000-8000-000000000001",
        reqsOwned: 2,
        applications: 10,
        interviewsScheduled: 4,
        offersExtended: 2,
        hires: 1,
      },
      {
        recruiterMembershipId: "aaaaaaaa-0000-4000-8000-000000000002",
        reqsOwned: 1,
        applications: 10,
        interviewsScheduled: 1,
        offersExtended: 0,
        hires: 1,
      },
    ]);
    const json = JSON.stringify(figs);
    expect(json).not.toContain("aaaaaaaa");
    expect(figs.find((f) => f.key === "hires")?.value).toBe(2);
    expect(figs.find((f) => f.key === "hire_per_application_pct")?.value).toBe(10);
  });

  it("pipeline figures name the slowest stage with a readable label", () => {
    const figs = figuresForPipeline({
      funnel: [{ stage: "recruiter_review", count: 4 }],
      timeToFill: { medianDays: 30, p90Days: 60, hires: 5 },
      timeInStage: [
        { stage: "recruiter_review", medianDays: 2 },
        { stage: "tech_interview", medianDays: 9 },
      ],
      sourceMix: [],
      offers: { extended: 4, accepted: 3, declined: 1 },
      slaBreaches: [],
    } as never);
    expect(figs.find((f) => f.key === "slowest_stage_days")).toMatchObject({
      label: "Median days in Panel interview (slowest stage)",
      value: 9,
    });
    expect(figs.find((f) => f.key === "offer_acceptance_pct")?.value).toBe(75);
  });

  it("the prompt carries only the compact figure JSON", () => {
    const { system, user } = buildReportInsightsPrompt("pipeline", FIGURES);
    expect(system).toMatch(/ONLY the figures provided/);
    expect(user).toContain('"key":"hires"');
    expect(user).toContain("Report: Pipeline & speed");
  });
});

describe("PC-20 generateReportInsights (mock model)", () => {
  beforeEach(() => clearReportInsightsCache());

  const base = { tenantId: TENANT, reportKey: "pipeline" as const, filters: {} };

  it("disabled → no model call", async () => {
    const complete = vi.fn();
    const out = await generateReportInsights({
      ...base,
      figures: FIGURES,
      aiEnabled: false,
      complete,
    });
    expect(out.status).toBe("disabled");
    expect(complete).not.toHaveBeenCalled();
  });

  it("empty figures → none, no model call", async () => {
    const complete = vi.fn();
    const out = await generateReportInsights({ ...base, figures: [], aiEnabled: true, complete });
    expect(out).toMatchObject({ status: "empty", insights: [] });
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns checked sentences with the prompt version, and caches for 15 minutes", async () => {
    let now = 1_000_000;
    const complete = vi.fn(async () => ({
      insights: [
        {
          text: "Time to fill rose 22%, with 3 requisitions on hold.",
          figureKeys: ["ttf_change_pct", "on_hold"],
        },
        { text: "Hires reached 1,300.", figureKeys: ["hires"] },
      ],
    }));
    const args = { ...base, figures: FIGURES, aiEnabled: true, complete, now: () => now };
    const first = await generateReportInsights(args);
    expect(first).toMatchObject({
      status: "ok",
      dropped: 1,
      cached: false,
      promptVersion: REPORT_INSIGHTS_PROMPT_VERSION,
    });
    expect(first.insights).toHaveLength(1);

    now += REPORT_INSIGHTS_CACHE_TTL_MS - 1;
    const second = await generateReportInsights(args);
    expect(second.cached).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);

    now += 2;
    await generateReportInsights(args);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("different data (hash) or tenant never serves a cached sentence", async () => {
    const complete = vi.fn(async () => ({
      insights: [{ text: "There were 1,250 hires.", figureKeys: ["hires"] }],
    }));
    await generateReportInsights({ ...base, figures: FIGURES, aiEnabled: true, complete });
    const changed = FIGURES.map((f) => (f.key === "hires" ? { ...f, value: 1251 } : f));
    const out = await generateReportInsights({
      ...base,
      figures: changed,
      aiEnabled: true,
      complete,
    });
    expect(out.cached).toBe(false);
    expect(out.status).toBe("unavailable"); // 1,250 is no longer a figure → dropped
    await generateReportInsights({
      ...base,
      tenantId: "22222222-2222-4222-8222-222222222222",
      figures: FIGURES,
      aiEnabled: true,
      complete,
    });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("cache key is filter-order independent", () => {
    expect(insightsCacheKey(TENANT, "pipeline", { from: "a", to: "b" } as never, FIGURES)).toBe(
      insightsCacheKey(TENANT, "pipeline", { to: "b", from: "a" } as never, FIGURES),
    );
  });

  it("a failing or malformed model → unavailable, never throws", async () => {
    const boom = vi.fn(async () => {
      throw new Error("down");
    });
    expect(
      (await generateReportInsights({ ...base, figures: FIGURES, aiEnabled: true, complete: boom }))
        .status,
    ).toBe("unavailable");
    const junk = vi.fn(async () => ({ nope: true }));
    expect(
      (await generateReportInsights({ ...base, figures: FIGURES, aiEnabled: true, complete: junk }))
        .status,
    ).toBe("unavailable");
  });
});
