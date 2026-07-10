/**
 * Render tests for renderTemplate.
 *
 * Focus is FOLLOWUP-01's `candidate.agent_message` — the only template
 * whose body is model-generated, recruiter-approved text rather than
 * fixed copy. The load-bearing guarantees:
 *   1. The caller-owned subject wins, with a sane fallback.
 *   2. The approved body reaches the rendered output.
 *   3. Any HTML/script in the body is ESCAPED, never injected — the body
 *      passes through a candidate's inbox and must not be a markup hole.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/render";

const baseData = {
  candidateName: "Anika",
  companyName: "Kyndryl GCC",
  positionTitle: "Senior Backend Engineer",
  body: "Hi Anika,\n\nJust checking in on your application.\n\nBest,",
  subject: "A quick note about your application",
};

describe("candidate.agent_message", () => {
  it("uses the caller-owned subject", async () => {
    const r = await renderTemplate("candidate.agent_message", baseData);
    expect(r.subject).toBe("A quick note about your application");
  });

  it("falls back to a role-based subject when none is supplied", async () => {
    const { subject: _omit, ...noSubject } = baseData;
    const r = await renderTemplate("candidate.agent_message", noSubject);
    expect(r.subject).toBe("Update on your application — Senior Backend Engineer");
  });

  it("renders the approved body and the tenant sign-off", async () => {
    const r = await renderTemplate("candidate.agent_message", baseData);
    expect(r.html).toContain("Just checking in on your application");
    expect(r.text).toContain("recruiting team");
  });

  it("degrades gracefully when the body is missing instead of crashing the send", async () => {
    const { body: _omit, ...noBody } = baseData;
    const r = await renderTemplate("candidate.agent_message", noBody);
    // Must not throw; still produces a usable email addressed to the candidate.
    expect(r.html).toContain("Anika");
    expect(r.text).toContain("recruiting team");
  });

  it("escapes HTML in the body instead of injecting it", async () => {
    const r = await renderTemplate("candidate.agent_message", {
      ...baseData,
      body: "Hello <script>alert(1)</script> <b>bold</b>",
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).not.toContain("<b>bold</b>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});
