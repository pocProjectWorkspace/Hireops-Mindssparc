/**
 * IRIS-A1 — action-registry contract (pure, no DB).
 *
 * HONESTY focus. The registry is the whitelist that bounds what the
 * user-invoked assistant can ever do: irisExecute can only dispatch through it.
 * These are the pure guarantees that make that bound real —
 *   - the one wired action (create_requisition_jd) is registered and reachable
 *     by id, and NOTHING else is;
 *   - its input contract genuinely rejects an empty / malformed payload (so a
 *     "confirm" can't commit a junk requisition);
 *   - its preview is non-empty (the client has something to show pre-confirm);
 *   - the serialisable menu is exactly the registry, projected to the wire
 *     shape, and JSON-round-trips (no server code leaks into the menu).
 *
 * Kept DB-free so the whitelist contract is covered without live-DB flake; the
 * end-to-end honesty (real gated write + persisted+read-back provenance) is the
 * iris-a1 integration test.
 */

import { describe, it, expect } from "vitest";
import { IRIS_ACTIONS, getIrisAction, listIrisActions } from "../src/lib/iris/registry";
import { createRequisitionJdAction } from "../src/lib/iris/actions/create-requisition-jd";
import { advanceApplicationAction } from "../src/lib/iris/actions/advance-application";
import { rejectApplicationAction } from "../src/lib/iris/actions/reject-application";
import { openOnboardingCaseAction } from "../src/lib/iris/actions/open-onboarding-case";
import { bulkAdvanceApplicationsAction } from "../src/lib/iris/actions/bulk-advance-applications";
import { bulkRejectApplicationsAction } from "../src/lib/iris/actions/bulk-reject-applications";
import { messageCandidateAction } from "../src/lib/iris/actions/message-candidate";
import { holdRequisitionAction } from "../src/lib/iris/actions/hold-requisition";
import { resumeRequisitionAction } from "../src/lib/iris/actions/resume-requisition";

describe("IRIS-A1 action registry", () => {
  it("registers create_requisition_jd and exposes it by id", () => {
    const action = getIrisAction("create_requisition_jd");
    expect(action).toBeDefined();
    expect(action!.id).toBe("create_requisition_jd");
    expect(IRIS_ACTIONS.create_requisition_jd).toBeDefined();
    // The registered entry mirrors the concrete action's descriptor.
    expect(action!.label).toBe(createRequisitionJdAction.label);
    expect(action!.group).toBe(createRequisitionJdAction.group);
    expect(action!.destructive).toBe(createRequisitionJdAction.destructive);
    expect(action!.bulk).toBe(createRequisitionJdAction.bulk);
    // Every registry key equals its action's own id (no id/key drift).
    for (const [key, entry] of Object.entries(IRIS_ACTIONS)) {
      expect(entry.id).toBe(key);
    }
  });

  it("returns undefined for an unknown / non-whitelisted action id", () => {
    expect(getIrisAction("drop_all_requisitions")).toBeUndefined();
    expect(getIrisAction("")).toBeUndefined();
    expect(getIrisAction("createRequisitionDraft")).toBeUndefined();
  });

  it("create_requisition_jd inputSchema rejects empty / invalid payloads", () => {
    const schema = createRequisitionJdAction.inputSchema;
    // Empty object — title + locationType are the required minimum.
    expect(schema.safeParse({}).success).toBe(false);
    // Missing locationType.
    expect(schema.safeParse({ title: "Staff Engineer" }).success).toBe(false);
    // Missing title.
    expect(schema.safeParse({ locationType: "hybrid" }).success).toBe(false);
    // Title too short (min 2) — a malformed value can't slip through.
    expect(schema.safeParse({ title: "x", locationType: "hybrid" }).success).toBe(false);
    // Bogus locationType.
    expect(schema.safeParse({ title: "Staff Engineer", locationType: "moon" }).success).toBe(false);
    // A valid minimum parses.
    expect(schema.safeParse({ title: "Staff Engineer", locationType: "hybrid" }).success).toBe(
      true,
    );
  });

  it("the registered (erased) entry's parse enforces the same contract irisExecute runs", () => {
    // irisExecute validates via getIrisAction(id).parse(rawParams) — the erased
    // boundary must reject junk and accept a valid minimum, exactly like the
    // concrete inputSchema.
    const entry = getIrisAction("create_requisition_jd")!;
    expect(() => entry.parse({})).toThrow();
    expect(() => entry.parse({ title: "x", locationType: "hybrid" })).toThrow();
    const parsed = entry.parse({ title: "Staff Engineer", locationType: "hybrid" }) as {
      title: string;
    };
    expect(parsed.title).toBe("Staff Engineer");
  });

  it("buildPreview returns a non-empty summary + details", () => {
    const preview = createRequisitionJdAction.buildPreview({
      title: "Staff Engineer",
      locationType: "hybrid",
      primaryLocation: "Bengaluru",
      seniority: "Senior",
      numberOfOpenings: 2,
    });
    expect(preview.summary.length).toBeGreaterThan(0);
    expect(preview.summary).toContain("Staff Engineer");
    expect(Array.isArray(preview.details)).toBe(true);
    expect(preview.details.length).toBeGreaterThan(0);
    for (const line of preview.details) {
      expect(typeof line).toBe("string");
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("listIrisActions() is the whitelist, serialisable, and shape-exact", () => {
    const menu = listIrisActions();
    // Whitelist-only: exactly the registry, same ids.
    expect(menu.map((m) => m.id).sort()).toEqual(Object.keys(IRIS_ACTIONS).sort());
    // Every entry carries EXACTLY the wire fields — no zod / server code leaks.
    // IRIS-B1.1 adds `roles` (the per-action app-surface role set) to the menu.
    for (const entry of menu) {
      expect(Object.keys(entry).sort()).toEqual(
        ["bulk", "destructive", "group", "id", "label", "roles"].sort(),
      );
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.group).toBe("string");
      expect(typeof entry.destructive).toBe("boolean");
      expect(typeof entry.bulk).toBe("boolean");
      expect(Array.isArray(entry.roles)).toBe(true);
      expect(entry.roles.length).toBeGreaterThan(0);
      for (const role of entry.roles) expect(typeof role).toBe("string");
    }
    // JSON round-trips byte-for-byte (genuinely serialisable).
    expect(JSON.parse(JSON.stringify(menu))).toEqual(menu);
  });
});

describe("IRIS-B1 pipeline / onboarding actions", () => {
  const B1_ACTIONS = [advanceApplicationAction, rejectApplicationAction, openOnboardingCaseAction];

  it("registers advance_application, reject_application, open_onboarding_case (whitelist-only)", () => {
    for (const action of B1_ACTIONS) {
      const entry = getIrisAction(action.id);
      expect(entry, `${action.id} is registered`).toBeDefined();
      expect(entry!.id).toBe(action.id);
      expect(entry!.label).toBe(action.label);
      expect(entry!.group).toBe(action.group);
      expect(entry!.destructive).toBe(action.destructive);
      expect(IRIS_ACTIONS[action.id]).toBeDefined();
    }
    // The one requisition action is untouched; the whitelist is exactly these
    // nine (four single + the two IRIS-B2 bulk pipeline actions + the
    // Communication message_candidate action + the two requisition hold/resume
    // lifecycle actions).
    expect(Object.keys(IRIS_ACTIONS).sort()).toEqual(
      [
        "advance_application",
        "create_requisition_jd",
        "open_onboarding_case",
        "reject_application",
        "bulk_advance_applications",
        "bulk_reject_applications",
        "message_candidate",
        "hold_requisition",
        "resume_requisition",
      ].sort(),
    );
  });

  it("each action carries its expected per-action roles (IRIS-B1.1)", () => {
    // The roles mirror the app-surface roles a human needs to run each action.
    // admin is the super-role present in every action's set.
    expect(createRequisitionJdAction.roles.sort()).toEqual(["admin", "hiring_manager"].sort());
    expect(advanceApplicationAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    expect(rejectApplicationAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    expect(openOnboardingCaseAction.roles.sort()).toEqual(
      ["admin", "recruiter", "hr_ops", "people_ops"].sort(),
    );
    // The erased registry entries carry the SAME roles the concrete actions do.
    for (const action of [createRequisitionJdAction, ...B1_ACTIONS]) {
      expect(getIrisAction(action.id)!.roles).toEqual(action.roles);
    }
    // admin is in every action's role set (sees + can run everything).
    for (const entry of listIrisActions()) {
      expect(entry.roles).toContain("admin");
    }
  });

  it("groups + destructive flags: reject is destructive, advance / onboarding are not", () => {
    expect(advanceApplicationAction.group).toBe("Pipeline");
    expect(advanceApplicationAction.destructive).toBe(false);
    expect(rejectApplicationAction.group).toBe("Pipeline");
    // The one destructive action in this ticket — the drawer shows destructive framing.
    expect(rejectApplicationAction.destructive).toBe(true);
    expect(openOnboardingCaseAction.group).toBe("Onboarding");
    expect(openOnboardingCaseAction.destructive).toBe(false);
  });

  it("inputSchemas reject invalid payloads and accept the real minimum", () => {
    // advance_application — needs a uuid applicationId + a valid stage.
    expect(advanceApplicationAction.inputSchema.safeParse({}).success).toBe(false);
    expect(
      advanceApplicationAction.inputSchema.safeParse({ applicationId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      advanceApplicationAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
        targetStage: "moon",
      }).success,
    ).toBe(false);
    expect(
      advanceApplicationAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
        targetStage: "shortlisted",
      }).success,
    ).toBe(true);

    // reject_application — needs a uuid applicationId (reason optional at the
    // schema; the drawer requires it client-side).
    expect(rejectApplicationAction.inputSchema.safeParse({}).success).toBe(false);
    expect(rejectApplicationAction.inputSchema.safeParse({ applicationId: "nope" }).success).toBe(
      false,
    );
    expect(
      rejectApplicationAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
        reason: "Not a fit for the role",
      }).success,
    ).toBe(true);

    // open_onboarding_case — applicationId only.
    expect(openOnboardingCaseAction.inputSchema.safeParse({}).success).toBe(false);
    expect(
      openOnboardingCaseAction.inputSchema.safeParse({
        applicationId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("buildPreview returns a non-empty summary for each action, naming the reason on reject", () => {
    const advance = advanceApplicationAction.buildPreview({
      applicationId: "11111111-1111-4111-8111-111111111111",
      targetStage: "tech_interview",
    });
    expect(advance.summary.length).toBeGreaterThan(0);
    expect(advance.summary.toLowerCase()).toContain("tech interview");

    const reject = rejectApplicationAction.buildPreview({
      applicationId: "11111111-1111-4111-8111-111111111111",
      reason: "Salary expectations too high",
    });
    expect(reject.summary.length).toBeGreaterThan(0);
    // The preview names the reason so the destructive review card shows it.
    expect(reject.details.join(" ")).toContain("Salary expectations too high");

    const onboarding = openOnboardingCaseAction.buildPreview({
      applicationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(onboarding.summary.length).toBeGreaterThan(0);
  });

  it("the erased entries enforce the same input contract irisExecute runs", () => {
    for (const action of B1_ACTIONS) {
      const entry = getIrisAction(action.id)!;
      expect(() => entry.parse({})).toThrow();
    }
    const advanceParsed = getIrisAction("advance_application")!.parse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      targetStage: "shortlisted",
    }) as { targetStage: string };
    expect(advanceParsed.targetStage).toBe("shortlisted");
  });
});

describe("IRIS-B2 bulk pipeline actions", () => {
  const B2_ACTIONS = [bulkAdvanceApplicationsAction, bulkRejectApplicationsAction];
  const REQ_UUID = "11111111-1111-4111-8111-111111111111";

  it("registers bulk_advance_applications + bulk_reject_applications (whitelist-only), each bulk:true with a resolve", () => {
    for (const action of B2_ACTIONS) {
      const entry = getIrisAction(action.id);
      expect(entry, `${action.id} is registered`).toBeDefined();
      expect(entry!.id).toBe(action.id);
      expect(entry!.label).toBe(action.label);
      expect(entry!.group).toBe("Pipeline");
      expect(entry!.bulk).toBe(true);
      // FILTER-based actions carry a resolver (single actions do not).
      expect(typeof entry!.resolve).toBe("function");
      expect(typeof action.resolve).toBe("function");
    }
    // A non-bulk single action carries NO resolver.
    expect(getIrisAction("advance_application")!.resolve).toBeUndefined();
  });

  it("carries the pipeline roles (admin + recruiter) and the right destructive flags", () => {
    expect(bulkAdvanceApplicationsAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    expect(bulkRejectApplicationsAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    // Advance is non-destructive; bulk reject ends applications → destructive.
    expect(bulkAdvanceApplicationsAction.destructive).toBe(false);
    expect(bulkRejectApplicationsAction.destructive).toBe(true);
    // The erased registry entries mirror the concrete roles.
    for (const action of B2_ACTIONS) {
      expect(getIrisAction(action.id)!.roles).toEqual(action.roles);
      expect(getIrisAction(action.id)!.destructive).toBe(action.destructive);
    }
  });

  it("inputSchemas reject invalid filters and accept the real minimum", () => {
    // bulk_advance — needs a uuid requisitionId + valid from/target stages.
    const adv = bulkAdvanceApplicationsAction.inputSchema;
    expect(adv.safeParse({}).success).toBe(false);
    expect(adv.safeParse({ requisitionId: "not-a-uuid" }).success).toBe(false);
    expect(adv.safeParse({ requisitionId: REQ_UUID, fromStage: "recruiter_review" }).success).toBe(
      false,
    );
    expect(
      adv.safeParse({ requisitionId: REQ_UUID, fromStage: "moon", targetStage: "shortlisted" })
        .success,
    ).toBe(false);
    expect(
      adv.safeParse({
        requisitionId: REQ_UUID,
        fromStage: "recruiter_review",
        targetStage: "shortlisted",
      }).success,
    ).toBe(true);

    // bulk_reject — needs a uuid requisitionId + a valid fromStage (reason optional).
    const rej = bulkRejectApplicationsAction.inputSchema;
    expect(rej.safeParse({}).success).toBe(false);
    expect(rej.safeParse({ requisitionId: REQ_UUID }).success).toBe(false);
    expect(rej.safeParse({ requisitionId: REQ_UUID, fromStage: "recruiter_review" }).success).toBe(
      true,
    );
    expect(
      rej.safeParse({
        requisitionId: REQ_UUID,
        fromStage: "recruiter_review",
        reason: "Not a fit",
      }).success,
    ).toBe(true);
  });

  it("buildPreview summarises the FILTER (scope + stages), reject making the destructive scope explicit", () => {
    const advance = bulkAdvanceApplicationsAction.buildPreview({
      requisitionId: REQ_UUID,
      fromStage: "recruiter_review",
      targetStage: "tech_interview",
    });
    expect(advance.summary.length).toBeGreaterThan(0);
    expect(advance.summary.toLowerCase()).toContain("recruiter review");
    expect(advance.summary.toLowerCase()).toContain("tech interview");

    const reject = bulkRejectApplicationsAction.buildPreview({
      requisitionId: REQ_UUID,
      fromStage: "recruiter_review",
      reason: "Requisition cancelled",
    });
    expect(reject.summary.length).toBeGreaterThan(0);
    // The reject preview makes the destructive scope + reason explicit.
    expect(reject.details.join(" ").toLowerCase()).toContain("ends");
    expect(reject.details.join(" ")).toContain("Requisition cancelled");
  });

  it("the erased entries enforce the same input contract irisExecute runs", () => {
    for (const action of B2_ACTIONS) {
      const entry = getIrisAction(action.id)!;
      expect(() => entry.parse({})).toThrow();
    }
    const parsed = getIrisAction("bulk_advance_applications")!.parse({
      requisitionId: REQ_UUID,
      fromStage: "recruiter_review",
      targetStage: "shortlisted",
    }) as { targetStage: string };
    expect(parsed.targetStage).toBe("shortlisted");
  });
});

describe("Iris Communication — message_candidate", () => {
  const APP_UUID = "22222222-2222-4222-8222-222222222222";

  it("registers message_candidate (whitelist-only): Communication group, non-destructive, single", () => {
    const entry = getIrisAction("message_candidate");
    expect(entry, "message_candidate is registered").toBeDefined();
    expect(entry!.id).toBe("message_candidate");
    expect(entry!.label).toBe(messageCandidateAction.label);
    expect(entry!.group).toBe("Communication");
    expect(entry!.destructive).toBe(false);
    expect(entry!.bulk).toBe(false);
    // A single (non-filter) action carries no resolver.
    expect(entry!.resolve).toBeUndefined();
    // The erased entry mirrors the concrete descriptor.
    expect(entry!.roles).toEqual(messageCandidateAction.roles);
  });

  it("carries the recruiter-surface roles (admin + recruiter)", () => {
    expect(messageCandidateAction.roles.sort()).toEqual(["admin", "recruiter"].sort());
    // admin is in the set (the super-role sees + can run it).
    expect(messageCandidateAction.roles).toContain("admin");
  });

  it("inputSchema validates the final human-confirmed message + rejects malformed payloads", () => {
    const schema = messageCandidateAction.inputSchema;
    // Empty — needs a uuid applicationId + non-empty subject + non-empty body.
    expect(schema.safeParse({}).success).toBe(false);
    // Bad applicationId.
    expect(
      schema.safeParse({ applicationId: "not-a-uuid", subject: "Hi", body: "Hello" }).success,
    ).toBe(false);
    // Missing body.
    expect(schema.safeParse({ applicationId: APP_UUID, subject: "Hi" }).success).toBe(false);
    // Empty subject / body are rejected (min 1).
    expect(schema.safeParse({ applicationId: APP_UUID, subject: "", body: "Hello" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ applicationId: APP_UUID, subject: "Hi", body: "" }).success).toBe(
      false,
    );
    // Subject over 200 / body over 4000 are rejected (bounds match the send contract).
    expect(
      schema.safeParse({ applicationId: APP_UUID, subject: "x".repeat(201), body: "Hello" })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ applicationId: APP_UUID, subject: "Hi", body: "x".repeat(4001) }).success,
    ).toBe(false);
    // A valid message parses.
    expect(
      schema.safeParse({
        applicationId: APP_UUID,
        subject: "Update on your application",
        body: "Hi there, we'd love to move you to the next round.",
      }).success,
    ).toBe(true);
  });

  it("the erased entry enforces the same input contract irisExecute runs", () => {
    const entry = getIrisAction("message_candidate")!;
    expect(() => entry.parse({})).toThrow();
    const parsed = entry.parse({
      applicationId: APP_UUID,
      subject: "Update on your application",
      body: "Hi there, we're moving you forward.",
    }) as { subject: string; body: string };
    expect(parsed.subject).toBe("Update on your application");
    expect(parsed.body).toContain("moving you forward");
  });

  it("buildPreview returns a non-empty summary + details naming the subject and body snippet", () => {
    const preview = messageCandidateAction.buildPreview({
      applicationId: APP_UUID,
      subject: "Update on your Backend Engineer application",
      body: "Hi Priya, we'd love to invite you to a final interview next week.",
    });
    expect(preview.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(preview.details)).toBe(true);
    expect(preview.details.length).toBeGreaterThan(0);
    // The preview surfaces the subject so the review card shows what will be sent.
    expect(preview.details.join(" ")).toContain("Update on your Backend Engineer application");
    // And a snippet of the body.
    expect(preview.details.join(" ")).toContain("final interview");
  });
});

describe("Iris Requisitions — hold_requisition / resume_requisition", () => {
  const REQ_UUID = "33333333-3333-4333-8333-333333333333";
  // The exact string membership of REQUISITION_POST_ROLES (the set postRequisition
  // and setRequisitionHold gate on) — the actions mirror it.
  const POST_ROLES = ["admin", "hiring_manager", "recruiter"];
  const HOLD_ACTIONS = [holdRequisitionAction, resumeRequisitionAction];

  it("registers both (whitelist-only): Requisitions group, non-destructive, single, no resolver", () => {
    for (const action of HOLD_ACTIONS) {
      const entry = getIrisAction(action.id);
      expect(entry, `${action.id} is registered`).toBeDefined();
      expect(entry!.id).toBe(action.id);
      expect(entry!.label).toBe(action.label);
      expect(entry!.group).toBe("Requisitions");
      // Reversible lifecycle changes — NOT flagged destructive (close/cancel,
      // which are, are deliberately out of scope).
      expect(entry!.destructive).toBe(false);
      expect(entry!.bulk).toBe(false);
      // Single (non-filter) actions carry no resolver.
      expect(entry!.resolve).toBeUndefined();
      expect(IRIS_ACTIONS[action.id]).toBeDefined();
    }
    expect(getIrisAction("hold_requisition")!.id).toBe("hold_requisition");
    expect(getIrisAction("resume_requisition")!.id).toBe("resume_requisition");
  });

  it("each carries EXACTLY the REQUISITION_POST_ROLES membership", () => {
    expect(holdRequisitionAction.roles.sort()).toEqual([...POST_ROLES].sort());
    expect(resumeRequisitionAction.roles.sort()).toEqual([...POST_ROLES].sort());
    // The erased registry entries mirror the concrete roles, and admin is present.
    for (const action of HOLD_ACTIONS) {
      expect(getIrisAction(action.id)!.roles).toEqual(action.roles);
      expect(action.roles).toContain("admin");
    }
  });

  it("hold_requisition inputSchema requires a uuid + a non-empty reason; resume needs only the uuid", () => {
    const hold = holdRequisitionAction.inputSchema;
    // Empty / bad id.
    expect(hold.safeParse({}).success).toBe(false);
    expect(hold.safeParse({ requisitionId: "not-a-uuid", reason: "budget freeze" }).success).toBe(
      false,
    );
    // Missing reason — hold REQUIRES a human-entered reason.
    expect(hold.safeParse({ requisitionId: REQ_UUID }).success).toBe(false);
    // Empty reason is rejected (min 1); over 500 is rejected too.
    expect(hold.safeParse({ requisitionId: REQ_UUID, reason: "" }).success).toBe(false);
    expect(hold.safeParse({ requisitionId: REQ_UUID, reason: "x".repeat(501) }).success).toBe(
      false,
    );
    // A valid hold payload parses.
    expect(
      hold.safeParse({ requisitionId: REQ_UUID, reason: "Budget freeze this quarter" }).success,
    ).toBe(true);

    const resume = resumeRequisitionAction.inputSchema;
    expect(resume.safeParse({}).success).toBe(false);
    expect(resume.safeParse({ requisitionId: "nope" }).success).toBe(false);
    // resume takes NO reason — a stray reason is simply ignored by the schema.
    expect(resume.safeParse({ requisitionId: REQ_UUID }).success).toBe(true);
  });

  it("buildPreview names the reason on hold and describes the resume", () => {
    const hold = holdRequisitionAction.buildPreview({
      requisitionId: REQ_UUID,
      reason: "Awaiting revised headcount sign-off",
    });
    expect(hold.summary.length).toBeGreaterThan(0);
    expect(hold.details.join(" ")).toContain("Awaiting revised headcount sign-off");

    const resume = resumeRequisitionAction.buildPreview({ requisitionId: REQ_UUID });
    expect(resume.summary.length).toBeGreaterThan(0);
    expect(resume.summary.toLowerCase()).toContain("resume");
  });

  it("the erased entries enforce the same input contract irisExecute runs", () => {
    const holdEntry = getIrisAction("hold_requisition")!;
    // A hold with no reason is rejected at the erased boundary too.
    expect(() => holdEntry.parse({ requisitionId: REQ_UUID })).toThrow();
    const holdParsed = holdEntry.parse({ requisitionId: REQ_UUID, reason: "Budget freeze" }) as {
      reason: string;
    };
    expect(holdParsed.reason).toBe("Budget freeze");

    const resumeEntry = getIrisAction("resume_requisition")!;
    expect(() => resumeEntry.parse({})).toThrow();
    const resumeParsed = resumeEntry.parse({ requisitionId: REQ_UUID }) as {
      requisitionId: string;
    };
    expect(resumeParsed.requisitionId).toBe(REQ_UUID);
  });
});
