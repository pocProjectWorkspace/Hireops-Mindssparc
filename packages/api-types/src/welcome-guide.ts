import { z } from "zod";

/**
 * PC-18 — pre-joining welcome guide per business unit.
 *
 * Pure contracts + pure logic shared by the API (source CRUD, generation,
 * publish, candidate read), the worker drain (is there a guide to send?) and
 * the admin + candidate surfaces. No db, no io.
 *
 * PLATFORM FEATURE, TENANT CONTENT. Nothing client-specific lives in code:
 * the source material (BU overview, leaders, culture, first-week info, links)
 * is tenant-authored per business unit, with one organisation-wide default
 * (business_unit_id NULL). The AI turns that source into a warm, structured
 * guide; a human reviews, edits and publishes it. Only a PUBLISHED version is
 * ever shown to a candidate.
 *
 * GROUNDED, NOT INVENTED. The prompt forbids inventing names, facts and
 * numbers, and `groundWelcomeGuide` (below) enforces it after the call:
 *   - a person in "People you'll meet" whose name is not in the source leader
 *     list is dropped; a kept person's title/photo come from the source, never
 *     from the model;
 *   - a prose sentence (or FAQ) that mentions a proper noun or a number that
 *     appears nowhere in the source material is dropped.
 * What was dropped is kept on the guide row (grounding report) so the admin
 * sees it before publishing.
 */

// ─────────────────────────── sections ───────────────────────────

export const WELCOME_GUIDE_SECTION_KEYS = [
  "welcome",
  "business_unit",
  "people",
  "how_we_work",
  "first_week",
  "faqs",
] as const;
export const welcomeGuideSectionKeySchema = z.enum(WELCOME_GUIDE_SECTION_KEYS);
export type WelcomeGuideSectionKey = z.infer<typeof welcomeGuideSectionKeySchema>;

export const WELCOME_GUIDE_SECTION_LABELS: Record<WelcomeGuideSectionKey, string> = {
  welcome: "Welcome",
  business_unit: "Your business unit",
  people: "People you'll meet",
  how_we_work: "How we work",
  first_week: "Your first week",
  faqs: "FAQs",
};

// ─────────────────────────── source material ───────────────────────────

export const WELCOME_SOURCE_TEXT_MAX = 5000;
export const WELCOME_LEADERS_MAX = 20;
export const WELCOME_LINKS_MAX = 20;

/** http(s) only — these are rendered as <a href> / <img src> in the portal. */
const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

export const welcomeLeaderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  title: z.string().trim().max(120).default(""),
  bio: z.string().trim().max(600).default(""),
  photoUrl: httpUrl.nullable().default(null),
});
export type WelcomeLeader = z.infer<typeof welcomeLeaderSchema>;

export const welcomeLinkSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: httpUrl,
  kind: z.enum(["link", "video"]).default("link"),
});
export type WelcomeLink = z.infer<typeof welcomeLinkSchema>;

export const welcomeSourceFieldsSchema = z.object({
  overview: z.string().trim().max(WELCOME_SOURCE_TEXT_MAX).default(""),
  leaders: z
    .array(welcomeLeaderSchema)
    .max(WELCOME_LEADERS_MAX)
    .refine(
      (ls) => new Set(ls.map((l) => normaliseName(l.name))).size === ls.length,
      "Each leader can be listed once",
    )
    .default([]),
  culture: z.string().trim().max(WELCOME_SOURCE_TEXT_MAX).default(""),
  firstWeek: z.string().trim().max(WELCOME_SOURCE_TEXT_MAX).default(""),
  links: z.array(welcomeLinkSchema).max(WELCOME_LINKS_MAX).default([]),
});
export type WelcomeSourceFields = z.infer<typeof welcomeSourceFieldsSchema>;

/** Is there anything to generate from? (All-empty source → refuse to generate.) */
export function welcomeSourceHasContent(s: WelcomeSourceFields): boolean {
  return (
    s.overview.trim().length > 0 ||
    s.culture.trim().length > 0 ||
    s.firstWeek.trim().length > 0 ||
    s.leaders.length > 0
  );
}

// ─────────────────────────── guide content ───────────────────────────

export const welcomeGuidePersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  title: z.string().trim().max(120).default(""),
  about: z.string().trim().max(800).default(""),
});
export type WelcomeGuidePerson = z.infer<typeof welcomeGuidePersonSchema>;

export const welcomeGuideFaqSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(1500),
});
export type WelcomeGuideFaq = z.infer<typeof welcomeGuideFaqSchema>;

/** The stored (and admin-editable) guide body. One field per section. */
export const welcomeGuideContentSchema = z.object({
  welcome: z.string().trim().max(3000).default(""),
  businessUnit: z.string().trim().max(WELCOME_SOURCE_TEXT_MAX).default(""),
  people: z.array(welcomeGuidePersonSchema).max(WELCOME_LEADERS_MAX).default([]),
  howWeWork: z.string().trim().max(WELCOME_SOURCE_TEXT_MAX).default(""),
  firstWeek: z.string().trim().max(WELCOME_SOURCE_TEXT_MAX).default(""),
  faqs: z.array(welcomeGuideFaqSchema).max(12).default([]),
});
export type WelcomeGuideContent = z.infer<typeof welcomeGuideContentSchema>;

/** Which sections have something to show (the candidate page renders only these). */
export function nonEmptyWelcomeSections(c: WelcomeGuideContent): WelcomeGuideSectionKey[] {
  const out: WelcomeGuideSectionKey[] = [];
  if (c.welcome.trim()) out.push("welcome");
  if (c.businessUnit.trim()) out.push("business_unit");
  if (c.people.length > 0) out.push("people");
  if (c.howWeWork.trim()) out.push("how_we_work");
  if (c.firstWeek.trim()) out.push("first_week");
  if (c.faqs.length > 0) out.push("faqs");
  return out;
}

// ─────────────────────────── grounding post-check ───────────────────────────

export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Capitalised words that are never "invented facts": calendar words and a
 * handful of grammatical capitals. Everything else capitalised in the guide
 * must appear somewhere in the source material.
 */
const GENERIC_ALLOWED = new Set([
  "i",
  "i'm",
  "i'll",
  "i've",
  "i'd",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "faq",
  "faqs",
  "ok",
]);

const WORD = /[\p{L}][\p{L}\p{M}'’-]*/gu;
const DIGIT_RUN = /\d+/g;

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

function foldWord(w: string): string {
  return w
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/'s$/, "");
}

/**
 * A word that names something: Capitalised (first letter upper) or an
 * ALL-CAPS acronym of 2+ letters. Both must be grounded in the source.
 */
function isCapitalised(w: string): boolean {
  return /^\p{Lu}/u.test(w) && (/\p{Ll}/u.test(w) || /^\p{Lu}{2,}$/u.test(w));
}

export interface WelcomeGroundingCorpus {
  /** Lowercased, folded words of every source field + allowed names. */
  vocabulary: Set<string>;
  /** Every digit run in the source material. */
  numbers: Set<string>;
  /** Source leaders keyed by normalised name. */
  leaders: Map<string, WelcomeLeader>;
}

/**
 * Build the grounding corpus from the source material plus names that are
 * facts the platform already knows (the tenant's display name, the business
 * unit's own name) — these are allowed in the guide without the admin having
 * to repeat them in the source text.
 */
export function buildWelcomeGroundingCorpus(
  source: WelcomeSourceFields,
  knownNames: readonly string[],
): WelcomeGroundingCorpus {
  const parts: string[] = [
    source.overview,
    source.culture,
    source.firstWeek,
    ...source.leaders.flatMap((l) => [l.name, l.title, l.bio]),
    ...source.links.map((l) => l.label),
    ...knownNames,
  ];
  const vocabulary = new Set<string>(GENERIC_ALLOWED);
  const numbers = new Set<string>();
  for (const p of parts) {
    for (const w of words(p)) vocabulary.add(foldWord(w));
    for (const n of p.match(DIGIT_RUN) ?? []) numbers.add(n);
  }
  const leaders = new Map<string, WelcomeLeader>();
  for (const l of source.leaders) leaders.set(normaliseName(l.name), l);
  return { vocabulary, numbers, leaders };
}

/**
 * Terms in `sentence` that are not grounded in the corpus: capitalised words
 * whose folded form is not in the source vocabulary (names, places, products
 * the model introduced), plus digit runs not in the source.
 *
 * A capital at a clause start (sentence start, or after `:` `;` a dash, a
 * bracket, a quote or a bullet) is grammar, so it is only flagged when the
 * next word is ALSO an unknown capital (a "First Last" run).
 */
export function ungroundedTerms(sentence: string, corpus: WelcomeGroundingCorpus): string[] {
  const out: string[] = [];
  const ms = [...sentence.matchAll(WORD)];
  const unknownCap = (w: string | undefined) =>
    !!w && isCapitalised(w) && !corpus.vocabulary.has(foldWord(w));
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i] as RegExpMatchArray;
    const w = m[0];
    if (!unknownCap(w)) continue;
    const before = sentence.slice(0, m.index ?? 0).trimEnd();
    const clauseStart = before.length === 0 || /[:;([{"“'‘•*–—-]$/.test(before);
    if (clauseStart && !unknownCap(ms[i + 1]?.[0])) continue;
    out.push(w);
  }
  for (const n of sentence.match(DIGIT_RUN) ?? []) {
    if (!corpus.numbers.has(n)) out.push(n);
  }
  return out;
}

/** Prose → paragraphs → lines → sentences (keeps paragraph + line structure). */
function splitProse(text: string): string[][][] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split("\n")
        .map((line) =>
          line
            .split(/(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        )
        .filter((line) => line.length > 0),
    )
    .filter((para) => para.length > 0);
}

export interface WelcomeGroundingDrop {
  section: WelcomeGuideSectionKey;
  /** What was removed: a sentence, an FAQ question, or a person's name. */
  text: string;
  reason: "person_not_in_source" | "ungrounded_terms";
  /** The words/numbers that are not in the source material. */
  terms: string[];
}

export const welcomeGroundingReportSchema = z.object({
  dropped: z.array(
    z.object({
      section: welcomeGuideSectionKeySchema,
      text: z.string(),
      reason: z.enum(["person_not_in_source", "ungrounded_terms"]),
      terms: z.array(z.string()),
    }),
  ),
});
export type WelcomeGroundingReport = z.infer<typeof welcomeGroundingReportSchema>;

function groundProse(
  text: string,
  section: WelcomeGuideSectionKey,
  corpus: WelcomeGroundingCorpus,
  dropped: WelcomeGroundingDrop[],
): string {
  const keep = (s: string) => {
    const terms = ungroundedTerms(s, corpus);
    if (terms.length === 0) return true;
    dropped.push({ section, text: s, reason: "ungrounded_terms", terms });
    return false;
  };
  return splitProse(text)
    .map((para) =>
      para
        .map((line) => line.filter(keep).join(" "))
        .filter((line) => line.length > 0)
        .join("\n"),
    )
    .filter((para) => para.length > 0)
    .join("\n\n");
}

/**
 * The post-check every generated guide goes through before it is stored.
 * Returns the grounded content and what was dropped (never throws).
 */
export function groundWelcomeGuide(
  raw: WelcomeGuideContent,
  corpus: WelcomeGroundingCorpus,
): { content: WelcomeGuideContent; report: WelcomeGroundingReport } {
  const dropped: WelcomeGroundingDrop[] = [];

  const seen = new Set<string>();
  const people: WelcomeGuidePerson[] = [];
  for (const p of raw.people) {
    const key = normaliseName(p.name);
    const leader = corpus.leaders.get(key);
    if (!leader) {
      dropped.push({
        section: "people",
        text: p.name,
        reason: "person_not_in_source",
        terms: [p.name],
      });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      // Name + title come from the SOURCE, never the model.
      name: leader.name,
      title: leader.title,
      about: groundProse(p.about, "people", corpus, dropped),
    });
  }

  const faqs: WelcomeGuideFaq[] = [];
  for (const f of raw.faqs) {
    const terms = [...ungroundedTerms(f.question, corpus)];
    const answer = groundProse(f.answer, "faqs", corpus, dropped);
    if (terms.length > 0) {
      dropped.push({ section: "faqs", text: f.question, reason: "ungrounded_terms", terms });
      continue;
    }
    if (!answer) continue;
    faqs.push({ question: f.question, answer });
  }

  const content: WelcomeGuideContent = {
    welcome: groundProse(raw.welcome, "welcome", corpus, dropped),
    businessUnit: groundProse(raw.businessUnit, "business_unit", corpus, dropped),
    people,
    howWeWork: groundProse(raw.howWeWork, "how_we_work", corpus, dropped),
    firstWeek: groundProse(raw.firstWeek, "first_week", corpus, dropped),
    faqs,
  };
  return { content, report: { dropped } };
}

// ─────────────────────────── scope resolution ───────────────────────────

export type WelcomeScopeMatch = "own" | "ancestor" | "organisation";

/**
 * Which published guide a candidate sees: their requisition's business unit;
 * else the nearest ancestor BU that has a published guide; else the
 * organisation default; else none. `parents` maps BU id → parent id (null at
 * the top). Cycle-safe (a corrupt hierarchy stops at the first repeat).
 */
export function resolveWelcomeScope(args: {
  businessUnitId: string | null;
  parents: ReadonlyMap<string, string | null>;
  publishedBusinessUnitIds: ReadonlySet<string>;
  organisationPublished: boolean;
}): { businessUnitId: string | null; match: WelcomeScopeMatch } | null {
  const seen = new Set<string>();
  let cur = args.businessUnitId;
  let depth = 0;
  while (cur && !seen.has(cur) && depth < 50) {
    if (args.publishedBusinessUnitIds.has(cur)) {
      return { businessUnitId: cur, match: depth === 0 ? "own" : "ancestor" };
    }
    seen.add(cur);
    cur = args.parents.get(cur) ?? null;
    depth += 1;
  }
  return args.organisationPublished ? { businessUnitId: null, match: "organisation" } : null;
}

// ─────────────────────────── statuses ───────────────────────────

export const WELCOME_GUIDE_STATUSES = ["draft", "published", "superseded", "discarded"] as const;
export const welcomeGuideStatusSchema = z.enum(WELCOME_GUIDE_STATUSES);
export type WelcomeGuideStatus = z.infer<typeof welcomeGuideStatusSchema>;

// ─────────────────────────── procedure contracts ───────────────────────────

/** null = the organisation-wide default. */
export const welcomeScopeInputSchema = z.object({ businessUnitId: z.guid().nullable() });

export const welcomeScopeRowSchema = z.object({
  businessUnitId: z.string().nullable(),
  name: z.string(),
  parentBusinessUnitId: z.string().nullable(),
  isArchived: z.boolean(),
  hasSource: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  hasDraft: z.boolean(),
});
export type WelcomeScopeRow = z.infer<typeof welcomeScopeRowSchema>;

export const listWelcomeScopesOutputSchema = z.object({
  /** Organisation default first, then business units by name. */
  scopes: z.array(welcomeScopeRowSchema),
  /** The `welcome_guide` AI feature (kill switch) is on. */
  generationEnabled: z.boolean(),
});
export type ListWelcomeScopesOutput = z.infer<typeof listWelcomeScopesOutputSchema>;

export const welcomeGuideVersionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: welcomeGuideStatusSchema,
  content: welcomeGuideContentSchema,
  groundingReport: welcomeGroundingReportSchema,
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  editedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WelcomeGuideVersion = z.infer<typeof welcomeGuideVersionSchema>;

export const getWelcomeContentOutputSchema = z.object({
  businessUnitId: z.string().nullable(),
  scopeName: z.string(),
  source: welcomeSourceFieldsSchema,
  sourceUpdatedAt: z.string().nullable(),
  /** Newest first. */
  versions: z.array(welcomeGuideVersionSchema),
});
export type GetWelcomeContentOutput = z.infer<typeof getWelcomeContentOutputSchema>;

export const upsertWelcomeSourceInputSchema = welcomeScopeInputSchema.extend({
  source: welcomeSourceFieldsSchema,
});
export type UpsertWelcomeSourceInput = z.infer<typeof upsertWelcomeSourceInputSchema>;

export const updateWelcomeGuideDraftInputSchema = z.object({
  guideId: z.guid(),
  content: welcomeGuideContentSchema,
});
export const welcomeGuideIdInputSchema = z.object({ guideId: z.guid() });

/** The candidate's view: what to render, with read receipts. */
export const candidateWelcomeGuideSchema = z.object({
  guideId: z.string(),
  companyName: z.string(),
  /** The business unit whose guide this is (null = organisation default). */
  scopeName: z.string().nullable(),
  content: welcomeGuideContentSchema,
  /** People enriched with the source photo (by name). */
  photos: z.record(z.string(), z.string()),
  links: z.array(welcomeLinkSchema),
  sections: z.array(welcomeGuideSectionKeySchema),
  viewedSections: z.array(welcomeGuideSectionKeySchema),
  joiningDate: z.string().nullable(),
  positionTitle: z.string().nullable(),
});
export type CandidateWelcomeGuide = z.infer<typeof candidateWelcomeGuideSchema>;

export const candidateGetMyWelcomeGuideOutputSchema = z.object({
  /** not_pre_joining: no accepted-not-joined offer; no_guide: nothing published. */
  status: z.enum(["available", "not_pre_joining", "no_guide"]),
  companyName: z.string(),
  guide: candidateWelcomeGuideSchema.nullable(),
});
export type CandidateGetMyWelcomeGuideOutput = z.infer<
  typeof candidateGetMyWelcomeGuideOutputSchema
>;

export const candidateMarkWelcomeSectionViewedInputSchema = z.object({
  guideId: z.guid(),
  section: welcomeGuideSectionKeySchema,
});
