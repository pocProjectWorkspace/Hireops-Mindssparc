import { describe, expect, it } from "vitest";
import { humanize, humanizeSentence, humanizeBool } from "../src/lib/labels";

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
