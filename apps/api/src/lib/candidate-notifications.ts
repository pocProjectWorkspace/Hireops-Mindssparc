/**
 * CAND-02 — candidate notification presentation map (PURE — no DB, no AI).
 *
 * The candidate Notifications feed (/candidate/notifications) is a person-scoped
 * read of REAL notification_outbox rows (recipient_type = 'candidate'). Those
 * rows carry a machine `template_key` (e.g. "candidate.interview_invitation")
 * and an email `subject`. This module maps a template_key to the human display
 * the feed shows — a category (drives icon/tint) and a title — plus a per-
 * category fallback body used when a row has no subject.
 *
 * NOTHING is fabricated: this only classifies + labels rows that already exist.
 * Unknown/new candidate template keys degrade gracefully (title derived from
 * the key, category "general") so a newly-added notification type still renders
 * honestly without a code change here.
 *
 * Sibling of the honest-verdict engines (comp-rules.ts / missing-info.ts): a
 * pure map the router calls and a unit test asserts directly.
 */

import type { CandidateNotificationCategory } from "@hireops/api-types";

export interface CandidateNotificationDisplay {
  category: CandidateNotificationCategory;
  title: string;
  /** Used as the body only when the outbox row has no real subject line. */
  fallbackBody: string;
}

/**
 * The registry. Keys are the real `template_key` values written to
 * notification_outbox with recipient_type = 'candidate' (see router.ts
 * candidate-directed enqueues). Editing this table is the only place candidate
 * notification labelling lives.
 */
const DISPLAY_BY_TEMPLATE: Record<string, CandidateNotificationDisplay> = {
  "candidate.interview_invitation": {
    category: "interview",
    title: "Interview scheduled",
    fallbackBody: "An interview has been scheduled. Open Interviews for the details.",
  },
  "candidate.interview_cancelled": {
    category: "interview",
    title: "Interview cancelled",
    fallbackBody: "A scheduled interview was cancelled. We'll be in touch with next steps.",
  },
  "candidate.stage_advanced": {
    category: "application",
    title: "Application advanced",
    fallbackBody: "Your application moved to the next stage.",
  },
  "candidate.application_received": {
    category: "application",
    title: "Application received",
    fallbackBody: "We've received your application. You can track its progress here.",
  },
  "candidate.offer_extended": {
    category: "offer",
    title: "Offer extended",
    fallbackBody: "An offer has been extended to you. Open your dashboard to review it.",
  },
  "candidate.account_activation": {
    category: "account",
    title: "Activate your account",
    fallbackBody: "Your candidate account is ready to activate.",
  },
  "candidate.agent_message": {
    category: "general",
    title: "Message from the hiring team",
    fallbackBody: "You have a new message from the hiring team.",
  },
};

const CATEGORY_HINTS: { match: RegExp; category: CandidateNotificationCategory }[] = [
  { match: /interview/, category: "interview" },
  { match: /offer/, category: "offer" },
  { match: /document|doc_|_doc/, category: "document" },
  { match: /activation|account|welcome/, category: "account" },
  { match: /stage|application|applied/, category: "application" },
];

/** Title-case the tail of a template key, e.g. "candidate.foo_bar" → "Foo bar". */
function deriveTitle(templateKey: string): string {
  const tail = templateKey.includes(".")
    ? templateKey.slice(templateKey.lastIndexOf(".") + 1)
    : templateKey;
  const words = tail.replace(/[_-]+/g, " ").trim();
  if (!words) return "Notification";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function deriveCategory(templateKey: string): CandidateNotificationCategory {
  const key = templateKey.toLowerCase();
  for (const hint of CATEGORY_HINTS) {
    if (hint.match.test(key)) return hint.category;
  }
  return "general";
}

/**
 * Display for a candidate notification `template_key`. Known keys use the
 * registry; unknown keys derive an honest title + category from the key itself.
 */
export function displayForCandidateNotification(templateKey: string): CandidateNotificationDisplay {
  const known = DISPLAY_BY_TEMPLATE[templateKey];
  if (known) return known;
  const title = deriveTitle(templateKey);
  return {
    category: deriveCategory(templateKey),
    title,
    fallbackBody: title,
  };
}
