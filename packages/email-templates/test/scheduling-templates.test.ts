/**
 * PC-8 / PC-9 / PC-10 — the four scheduling templates render, carry their
 * data, and the panellist invite carries a REAL .ics whose description points
 * at the brief (not the candidate's confirm link).
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/render";
import { EMAIL_TEMPLATE_CATALOG, EMAIL_TEMPLATE_SAMPLE_DATA } from "../src/catalog";

const KEYS = [
  "candidate.interview_slot_offer",
  "panelist.interview_scheduled",
  "panelist.interview_rescheduling",
  "recruiter.scheduling_alert",
] as const;

describe("scheduling templates", () => {
  it("every new key has a catalog entry and sample data, and renders", async () => {
    for (const key of KEYS) {
      expect(EMAIL_TEMPLATE_CATALOG[key].templateKey).toBe(key);
      const r = await renderTemplate(key, EMAIL_TEMPLATE_SAMPLE_DATA[key]!);
      expect(r.subject.length).toBeGreaterThan(5);
      expect(r.html).toContain("Priya Sharma");
    }
  });

  it("slot offer lists the slots and the pick link", async () => {
    const r = await renderTemplate(
      "candidate.interview_slot_offer",
      EMAIL_TEMPLATE_SAMPLE_DATA["candidate.interview_slot_offer"]!,
    );
    expect(r.html).toContain("Wed 5 Aug, 14:30 (UTC)");
    expect(r.html).toContain("https://portal.example/interviews/pick/token");
    expect(r.subject).toBe("Choose a time: Panel Round 1 for Plant Accountant");
  });

  it("slot offer explains a panellist's unavailability when that is the reason", async () => {
    const r = await renderTemplate("candidate.interview_slot_offer", {
      ...EMAIL_TEMPLATE_SAMPLE_DATA["candidate.interview_slot_offer"],
      reason: "panelist_unavailable",
    });
    expect(r.text).toContain("can no longer make the time");
  });

  it("panellist invite attaches an .ics pointing at the brief", async () => {
    const r = await renderTemplate("panelist.interview_scheduled", {
      ...EMAIL_TEMPLATE_SAMPLE_DATA["panelist.interview_scheduled"],
      interviewStartIso: "2026-08-04T10:00:00.000Z",
      interviewId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.attachments).toHaveLength(1);
    const ics = Buffer.from(r.attachments![0]!.content, "base64")
      .toString("utf8")
      .replace(/\r\n /g, ""); // unfold RFC-5545 continuation lines
    expect(ics).toContain("DTSTART:20260804T100000Z");
    expect(ics).toContain("DTEND:20260804T104500Z");
    expect(ics).toContain("UID:interview-11111111-1111-4111-8111-111111111111@hireops");
    expect(ics).toContain("Interview brief");
    expect(ics).not.toContain("Confirm attendance");
  });
});
