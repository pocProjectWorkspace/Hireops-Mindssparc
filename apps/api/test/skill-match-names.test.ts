import { describe, expect, it } from "vitest";
import { parsedSkillNames } from "../src/lib/skill-match";

describe("parsedSkillNames", () => {
  it("reads a bare string array", () => {
    expect(parsedSkillNames(["Month-End Close", "Advanced Excel"])).toEqual([
      "Month-End Close",
      "Advanced Excel",
    ]);
  });

  it("reads { skills: string[] } (seed / import shape)", () => {
    expect(parsedSkillNames({ skills: ["Cost Accounting"], notice_period_days: 30 })).toEqual([
      "Cost Accounting",
    ]);
  });

  it("reads the AI parser's { skills: { technical, domain } } shape", () => {
    expect(
      parsedSkillNames({ skills: { technical: ["SAP FI/CO"], domain: ["Record to Report"] } }),
    ).toEqual(["SAP FI/CO", "Record to Report"]);
  });

  it("returns [] for null, scalars and non-string entries", () => {
    expect(parsedSkillNames(null)).toEqual([]);
    expect(parsedSkillNames("Excel")).toEqual([]);
    expect(parsedSkillNames({ skills: [1, null, " "] })).toEqual([]);
  });
});
