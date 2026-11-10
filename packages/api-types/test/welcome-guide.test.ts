import { describe, expect, it } from "vitest";
import {
  buildWelcomeGroundingCorpus,
  groundWelcomeGuide,
  nonEmptyWelcomeSections,
  resolveWelcomeScope,
  ungroundedTerms,
  welcomeGuideContentSchema,
  welcomeSourceFieldsSchema,
  welcomeSourceHasContent,
  type WelcomeSourceFields,
} from "../src/welcome-guide";
import {
  WELCOME_GUIDE_DELAY_MS,
  defaultPreJoiningEngagementSettings,
  localParts,
  planPreJoiningTouchpoints,
  resolvePreJoiningEngagementSettings,
  type PreJoiningEngagementSettings,
} from "../src/pre-joining-engagement";

/**
 * PC-18 — the pure half of the welcome guide: the grounding post-check,
 * business-unit fallback, and the welcome_guide journey step.
 */

const SOURCE: WelcomeSourceFields = welcomeSourceFieldsSchema.parse({
  overview:
    "Finance Operations runs accounts payable and the monthly close for 14 plants from our Pune hub.",
  leaders: [
    {
      name: "Meera Iyer",
      title: "Head of Finance Operations",
      bio: "Meera has led the team since 2019 and mentors every new joiner.",
      photoUrl: "https://example.test/meera.jpg",
    },
    { name: "Rohan Desai", title: "Close Lead", bio: "" },
  ],
  culture: "We value ownership, plain speaking and helping each other hit the close.",
  firstWeek: "Day 1 starts at 9:30 with a laptop handover and a coffee with your buddy.",
});

const corpus = () => buildWelcomeGroundingCorpus(SOURCE, ["Acme Industrial", "Finance Operations"]);

describe("source material", () => {
  it("an all-empty source has nothing to generate from", () => {
    expect(welcomeSourceHasContent(welcomeSourceFieldsSchema.parse({}))).toBe(false);
    expect(welcomeSourceHasContent(SOURCE)).toBe(true);
  });

  it("rejects duplicate leaders and non-http(s) URLs", () => {
    expect(
      welcomeSourceFieldsSchema.safeParse({
        leaders: [{ name: "Meera Iyer" }, { name: "meera  iyer" }],
      }).success,
    ).toBe(false);
    expect(
      welcomeSourceFieldsSchema.safeParse({
        leaders: [{ name: "A", photoUrl: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    expect(
      welcomeSourceFieldsSchema.safeParse({
        links: [{ label: "Intro", url: "ftp://example.test/x" }],
      }).success,
    ).toBe(false);
  });
});

describe("grounding post-check", () => {
  it("drops a person not in the leader list and takes kept people's titles from the source", () => {
    const raw = welcomeGuideContentSchema.parse({
      people: [
        { name: "Meera Iyer", title: "CEO", about: "Meera mentors every new joiner." },
        { name: "Sanjay Kapoor", title: "Buddy", about: "Sanjay will show you around." },
        { name: "rohan desai", about: "Rohan leads the close." },
      ],
    });
    const { content, report } = groundWelcomeGuide(raw, corpus());
    expect(content.people.map((p) => p.name)).toEqual(["Meera Iyer", "Rohan Desai"]);
    expect(content.people[0]?.title).toBe("Head of Finance Operations"); // not the model's "CEO"
    expect(report.dropped).toContainEqual({
      section: "people",
      text: "Sanjay Kapoor",
      reason: "person_not_in_source",
      terms: ["Sanjay Kapoor"],
    });
  });

  it("drops a sentence with a number that is not in the source, keeps the rest", () => {
    const raw = welcomeGuideContentSchema.parse({
      businessUnit:
        "Finance Operations runs the monthly close for 14 plants. The team has 250 people. You'll work from Pune.",
    });
    const { content, report } = groundWelcomeGuide(raw, corpus());
    expect(content.businessUnit).toBe(
      "Finance Operations runs the monthly close for 14 plants. You'll work from Pune.",
    );
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0]).toMatchObject({
      section: "business_unit",
      reason: "ungrounded_terms",
      terms: ["250"],
    });
  });

  it("drops a sentence naming a person, place or product the source never mentions", () => {
    const raw = welcomeGuideContentSchema.parse({
      howWeWork:
        "We value ownership and plain speaking. Our Mumbai office runs on SAP. Ask Priya Nair anything.",
    });
    const { content, report } = groundWelcomeGuide(raw, corpus());
    expect(content.howWeWork).toBe("We value ownership and plain speaking.");
    const terms = report.dropped.flatMap((d) => d.terms);
    expect(terms).toEqual(expect.arrayContaining(["Mumbai", "SAP", "Priya", "Nair"]));
  });

  it("allows sentence-start capitals, calendar words and known names (company, BU)", () => {
    const c = corpus();
    expect(ungroundedTerms("Welcome to Acme Industrial!", c)).toEqual([]);
    expect(ungroundedTerms("On Monday you meet Meera.", c)).toEqual([]);
    expect(ungroundedTerms("Everyone helps each other hit the close.", c)).toEqual([]);
    // A sentence-start "First Last" pair is still a name.
    expect(ungroundedTerms("Priya Nair will meet you.", c)).toEqual(["Priya", "Nair"]);
  });

  it("drops an FAQ whose question or answer is ungrounded; keeps paragraph structure", () => {
    const raw = welcomeGuideContentSchema.parse({
      firstWeek: "Day 1 starts at 9:30.\n\nYou'll have coffee with your buddy.",
      faqs: [
        { question: "What time do I start?", answer: "Day 1 starts at 9:30." },
        { question: "Is there a gym?", answer: "Yes, open 24 hours." },
        { question: "Where is the Chennai office?", answer: "Near the station." },
      ],
    });
    const { content, report } = groundWelcomeGuide(raw, corpus());
    expect(content.firstWeek).toBe("Day 1 starts at 9:30.\n\nYou'll have coffee with your buddy.");
    expect(content.faqs.map((f) => f.question)).toEqual(["What time do I start?"]);
    expect(report.dropped.map((d) => d.section)).toEqual(["faqs", "faqs"]);
  });

  it("a fully grounded draft passes untouched", () => {
    const raw = welcomeGuideContentSchema.parse({
      welcome: "Welcome to Finance Operations at Acme Industrial.",
      howWeWork: "We value ownership, plain speaking and helping each other hit the close.",
    });
    const { content, report } = groundWelcomeGuide(raw, corpus());
    expect(report.dropped).toEqual([]);
    expect(content.welcome).toBe(raw.welcome);
    expect(nonEmptyWelcomeSections(content)).toEqual(["welcome", "how_we_work"]);
  });
});

describe("business-unit fallback", () => {
  // org → (A → A1 → A1x), B
  const parents = new Map<string, string | null>([
    ["A", null],
    ["A1", "A"],
    ["A1x", "A1"],
    ["B", null],
  ]);

  it("own BU first", () => {
    expect(
      resolveWelcomeScope({
        businessUnitId: "A1",
        parents,
        publishedBusinessUnitIds: new Set(["A1", "A"]),
        organisationPublished: true,
      }),
    ).toEqual({ businessUnitId: "A1", match: "own" });
  });

  it("then the NEAREST ancestor with a published guide", () => {
    expect(
      resolveWelcomeScope({
        businessUnitId: "A1x",
        parents,
        publishedBusinessUnitIds: new Set(["A"]),
        organisationPublished: true,
      }),
    ).toEqual({ businessUnitId: "A", match: "ancestor" });
  });

  it("then the organisation default; else nothing; never a sibling", () => {
    const args = { businessUnitId: "B", parents, publishedBusinessUnitIds: new Set(["A"]) };
    expect(resolveWelcomeScope({ ...args, organisationPublished: true })).toEqual({
      businessUnitId: null,
      match: "organisation",
    });
    expect(resolveWelcomeScope({ ...args, organisationPublished: false })).toBeNull();
  });

  it("is cycle-safe on a corrupt hierarchy", () => {
    const loop = new Map<string, string | null>([
      ["X", "Y"],
      ["Y", "X"],
    ]);
    expect(
      resolveWelcomeScope({
        businessUnitId: "X",
        parents: loop,
        publishedBusinessUnitIds: new Set(),
        organisationPublished: true,
      }),
    ).toEqual({ businessUnitId: null, match: "organisation" });
  });
});

describe("welcome_guide journey step", () => {
  const now = new Date("2026-11-10T06:00:00Z"); // 11:30 IST
  const IST = { enabled: true, startHour: 20, endHour: 8, timezone: "Asia/Kolkata" };
  const settings = (over: Partial<PreJoiningEngagementSettings> = {}) => ({
    ...defaultPreJoiningEngagementSettings(),
    enabled: true,
    quietHours: IST,
    ...over,
  });

  it("platform default: on, scheduled shortly after the welcome", () => {
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2027-01-15",
      acceptedAt: now,
      now,
      settings: settings(),
    });
    const welcome = plan.find((p) => p.stepKey === "welcome");
    const guide = plan.filter((p) => p.stepKey === "welcome_guide");
    expect(welcome).toBeDefined();
    expect(guide).toHaveLength(1);
    expect(guide[0]?.scheduledFor.getTime()).toBe(
      (welcome?.scheduledFor.getTime() ?? 0) + WELCOME_GUIDE_DELAY_MS,
    );
    expect(guide[0]?.carriesPulse).toBe(false);
  });

  it("respects quiet hours (an evening accept → next morning)", () => {
    const evening = new Date("2026-11-10T13:00:00Z"); // 18:30 IST → +2h = 20:30, quiet
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2027-01-15",
      acceptedAt: evening,
      now: evening,
      settings: settings(),
    });
    const g = plan.find((p) => p.stepKey === "welcome_guide");
    expect(g).toBeDefined();
    const local = localParts(g?.scheduledFor ?? new Date(0), "Asia/Kolkata");
    expect(local.date).toBe("2026-11-11");
    expect(local.hour).toBe(8);
  });

  it("a backfilled (long-accepted) candidate still gets the guide; a tenant can switch it off", () => {
    const acceptedAt = new Date("2026-09-01T06:00:00Z");
    const on = planPreJoiningTouchpoints({
      joiningDate: "2026-12-15",
      acceptedAt,
      now,
      settings: settings(),
    });
    expect(on.map((p) => p.stepKey)).not.toContain("welcome");
    expect(on.map((p) => p.stepKey)).toContain("welcome_guide");
    const off = planPreJoiningTouchpoints({
      joiningDate: "2026-12-15",
      acceptedAt,
      now,
      settings: settings({
        steps: defaultPreJoiningEngagementSettings().steps.map((s) =>
          s.key === "welcome_guide" ? { ...s, enabled: false } : s,
        ),
      }),
    });
    expect(off.map((p) => p.stepKey)).not.toContain("welcome_guide");
  });

  it("not sent on the joining day itself", () => {
    const plan = planPreJoiningTouchpoints({
      joiningDate: "2026-11-11",
      acceptedAt: new Date("2026-11-10T16:00:00Z"), // 21:30 IST → guide next morning = joining day
      now: new Date("2026-11-10T16:00:00Z"),
      settings: settings(),
    });
    expect(plan.map((p) => p.stepKey)).not.toContain("welcome_guide");
  });

  it("a saved steps list that predates the step gets the platform default (on), in order", () => {
    const stored = {
      enabled: true,
      steps: [
        { key: "welcome", enabled: true },
        { key: "pulse", enabled: false },
        { key: "company_update", enabled: true },
        { key: "two_weeks_to_go", enabled: true },
        { key: "one_week_to_go", enabled: true },
      ],
    };
    const s = resolvePreJoiningEngagementSettings(stored);
    expect(s.steps.map((x) => x.key)).toEqual([
      "welcome",
      "welcome_guide",
      "pulse",
      "company_update",
      "two_weeks_to_go",
      "one_week_to_go",
    ]);
    expect(s.steps.find((x) => x.key === "welcome_guide")?.enabled).toBe(true);
    expect(s.steps.find((x) => x.key === "pulse")?.enabled).toBe(false);
    // An explicit off is kept.
    const off = resolvePreJoiningEngagementSettings({
      ...stored,
      steps: [...stored.steps, { key: "welcome_guide", enabled: false }],
    });
    expect(off.steps.find((x) => x.key === "welcome_guide")?.enabled).toBe(false);
  });
});
