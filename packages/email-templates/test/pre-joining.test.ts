/**
 * PC-14/15 — the pre-joining journey emails + the recruiter signal alert.
 *
 *   - Every new key renders with its catalog sample data, with the catalog's
 *     default subject (interpolated).
 *   - Pulse-carrying steps include the check-in link; others don't.
 *   - Company-update content and first-day info are rendered as escaped text.
 *   - A tenant slot override replaces the default intro.
 *   - The recruiter alert carries the candidate's quote and says it is not a
 *     prediction.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/render";
import {
  EMAIL_TEMPLATE_CATALOG,
  EMAIL_TEMPLATE_SAMPLE_DATA,
  interpolateSlot,
} from "../src/catalog";
import type { TemplateKey } from "@hireops/notifications";

/** Narrow away undefined/null, failing loudly (instead of a non-null assertion). */
function must<V>(v: V | null | undefined, what = "value"): V {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

const KEYS: TemplateKey[] = [
  "candidate.pre_joining_welcome",
  "candidate.pre_joining_welcome_guide",
  "candidate.pre_joining_pulse",
  "candidate.pre_joining_company_update",
  "candidate.pre_joining_two_weeks",
  "candidate.pre_joining_one_week",
  "recruiter.joining_risk_signal",
];

describe("pre-joining templates", () => {
  it.each(KEYS)("%s renders with its sample data and catalog default subject", async (key) => {
    const data = EMAIL_TEMPLATE_SAMPLE_DATA[key];
    const r = await renderTemplate(key, data);
    const spec = must(EMAIL_TEMPLATE_CATALOG[key].subject);
    const tokens = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
    );
    expect(r.subject).toBe(interpolateSlot(spec.defaultText, tokens));
    expect(r.html.length).toBeGreaterThan(100);
    expect(r.text).toContain("Priya Sharma".split(" ")[0]);
  });

  it("welcome guide (PC-18): links to the guide with the default CTA; slot overrides apply", async () => {
    const data = EMAIL_TEMPLATE_SAMPLE_DATA["candidate.pre_joining_welcome_guide"];
    const r = await renderTemplate("candidate.pre_joining_welcome_guide", data);
    expect(r.subject).toBe("Get to know your new team at Your organisation");
    expect(r.html).toContain("https://portal.example/candidate/welcome");
    expect(r.text).toContain("Open your welcome guide");
    expect(r.text).toContain("sign in to your candidate account");
    const custom = await renderTemplate("candidate.pre_joining_welcome_guide", data, {
      slots: { guideCta: "Meet the team" },
    });
    expect(custom.text).toContain("Meet the team");
    // Without a guide URL there is no button (the drain never sends that case).
    const noUrl = await renderTemplate("candidate.pre_joining_welcome_guide", {
      ...data,
      guideUrl: null,
    });
    expect(noUrl.html).not.toContain("/candidate/welcome");
  });

  it("only pulse-carrying steps include the check-in link", async () => {
    const pulse = await renderTemplate(
      "candidate.pre_joining_pulse",
      EMAIL_TEMPLATE_SAMPLE_DATA["candidate.pre_joining_pulse"],
    );
    expect(pulse.html).toContain("https://portal.example/pulse/token");
    expect(pulse.text).toContain("Are you still on track to join on 8 February 2027?");
    const welcome = await renderTemplate("candidate.pre_joining_welcome", {
      ...EMAIL_TEMPLATE_SAMPLE_DATA["candidate.pre_joining_welcome"],
      pulseUrl: "https://portal.example/pulse/should-not-appear",
    });
    expect(welcome.html).not.toContain("should-not-appear");
  });

  it("company update + first-day info are rendered as escaped text", async () => {
    const cu = await renderTemplate("candidate.pre_joining_company_update", {
      ...EMAIL_TEMPLATE_SAMPLE_DATA["candidate.pre_joining_company_update"],
      updateBody: "Hello <script>alert(1)</script> team",
    });
    expect(cu.html).not.toContain("<script>");
    expect(cu.html).toContain("Our new Pune office is open");
    const ow = await renderTemplate(
      "candidate.pre_joining_one_week",
      EMAIL_TEMPLATE_SAMPLE_DATA["candidate.pre_joining_one_week"],
    );
    expect(ow.text).toContain("Please report to reception at 9:30 AM with a photo ID.");
  });

  it("a tenant slot override replaces the default intro", async () => {
    const r = await renderTemplate(
      "candidate.pre_joining_two_weeks",
      EMAIL_TEMPLATE_SAMPLE_DATA["candidate.pre_joining_two_weeks"],
      { slots: { intro: "Only {joiningDate} to go, {candidateName}!" } },
    );
    expect(r.text).toContain("Only 8 February 2027 to go, Priya Sharma!");
    expect(r.text).not.toContain("We're getting everything ready for you.");
  });

  it("recruiter alert carries the quote and states it is not a prediction", async () => {
    const r = await renderTemplate(
      "recruiter.joining_risk_signal",
      EMAIL_TEMPLATE_SAMPLE_DATA["recruiter.joining_risk_signal"],
    );
    expect(r.text).toContain("my current company has made a counter offer");
    expect(r.text).toContain("not a prediction");
    expect(r.text.toLowerCase()).not.toMatch(/score|probability|likelihood/);
  });
});
