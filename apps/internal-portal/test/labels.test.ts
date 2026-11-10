import { describe, expect, it } from "vitest";
import {
  applicationStageLabel,
  humanize,
  humanizeSentence,
  humanizeBool,
  recommendationLabel,
} from "../src/lib/labels";
import { resolveTenantLabels } from "@hireops/api-types";

describe("humanize", () => {
  it("title-cases snake_case and kebab-case tokens", () => {
    expect(humanize("hiring_manager")).toBe("Hiring Manager");
    expect(humanize("panel-member")).toBe("Panel Member");
    expect(humanize("recruiter")).toBe("Recruiter");
  });

  it("keeps acronyms in fixed casing (the whole point)", () => {
    expect(humanize("ai_screening")).toBe("AI Screening");
    expect(humanize("hr_ops")).toBe("HR Ops");
    expect(humanize("hr_head")).toBe("HR Head");
    expect(humanize("it_admin")).toBe("IT Admin");
    expect(humanize("jd_library")).toBe("JD Library");
    expect(humanize("sla_thresholds")).toBe("SLA Thresholds");
  });

  it("normalises already-spaced and mixed-case input", () => {
    expect(humanize("Application RECEIVED")).toBe("Application Received");
  });

  it("returns empty string for empty / nullish input", () => {
    expect(humanize("")).toBe("");
    expect(humanize(null)).toBe("");
    expect(humanize(undefined)).toBe("");
  });
});

describe("humanizeSentence", () => {
  it("capitalises only the first word", () => {
    expect(humanizeSentence("application_received")).toBe("Application received");
    expect(humanizeSentence("offer_drafted")).toBe("Offer drafted");
  });

  it("still fixes acronym casing wherever it falls", () => {
    expect(humanizeSentence("ai_screening")).toBe("AI screening");
    expect(humanizeSentence("pending_hr_round")).toBe("Pending HR round");
  });
});

describe("humanizeBool", () => {
  it("defaults to Yes / No", () => {
    expect(humanizeBool(true)).toBe("Yes");
    expect(humanizeBool(false)).toBe("No");
    expect(humanizeBool(null)).toBe("No");
  });

  it("accepts domain-specific copy", () => {
    expect(humanizeBool(true, { yes: "Required", no: "Optional" })).toBe("Required");
    expect(humanizeBool(false, { yes: "Required", no: "Optional" })).toBe("Optional");
  });
});

// CFG-LITE — a tenant's display-label override reaches the portal helpers.
describe("applicationStageLabel / recommendationLabel with tenant labels", () => {
  const labels = resolveTenantLabels({
    stages: { shortlisted: { staff: "Longlist", candidate: "Next step" } },
    recommendations: { strong_yes: "Accept" },
  });

  it("platform wording is unchanged without tenant labels", () => {
    expect(applicationStageLabel("tech_interview")).toBe("Panel interview");
    expect(applicationStageLabel("recruiter_rejected")).toBe("Rejected");
    expect(applicationStageLabel("shortlisted", null)).toBe("Shortlisted");
    expect(applicationStageLabel(null)).toBe("—");
    expect(recommendationLabel("strong_yes")).toBe("Strong yes");
  });

  it("a tenant STAFF override wins; other audiences don't leak in", () => {
    expect(applicationStageLabel("shortlisted", labels)).toBe("Longlist");
    expect(applicationStageLabel("hr_round", labels)).toBe("HR round");
    expect(recommendationLabel("strong_yes", labels)).toBe("Accept");
    expect(recommendationLabel("hold", labels)).toBe("Hold");
  });
});
