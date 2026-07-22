import type { TemplateKey } from "@hireops/notifications";

/**
 * EMAIL TEMPLATE SLOT CATALOG (T1.4 / G09) — the single source of truth for
 * which copy in each of the 12 transactional templates a tenant may override.
 *
 * WHY THIS FILE IS THE ONE SOURCE:
 * The resolver (render.ts), the API catalog/validation procedures
 * (getEmailTemplateCatalog / upsertEmailTemplateOverride), the admin editor,
 * and the live preview ALL read this catalog. The default copy strings live
 * here (and, byte-identically, as the JSX fallbacks in each template) so an
 * admin edits against the SAME text the template ships with.
 *
 * THE HONESTY BOUNDARY (this is the G-class this ticket fixes):
 * Only the SUBJECT and the NAMED TEXT SLOTS below are editable. There is NO
 * raw-HTML / full-body editor — that would open HTML injection and would break
 * the data bindings. Layout, styles, and every dynamic DATA binding
 * (candidate name, position title, company name, references, dates, the .ics
 * attachment, links, salary, …) stay code-owned. Each slot declares the exact
 * interpolation tokens it may reference; an override that uses an unknown token
 * (or an unknown slot) is rejected by the API. A template with a caller-owned
 * body (agent_message) or a fully worker-composed body (sla_ops_alert) exposes
 * only what is genuinely static text — the catalog never pretends otherwise.
 *
 * A tenant with NO override row renders BYTE-IDENTICALLY to today: render.ts
 * only substitutes a slot/subject when an override string is present, otherwise
 * the template's own JSX fallback (unchanged) is emitted.
 */

/** One overridable text run. `defaultText` is the plain-text form of the
 * template's shipped copy (the JSX fallback may add inline emphasis/links —
 * those are layout, not overridable). `tokens` is the closed set of `{token}`
 * placeholders an override may reference. */
export interface EmailTemplateSlot {
  slotKey: string;
  label: string;
  defaultText: string;
  tokens: string[];
}

/** The subject spec for a template. `null` when the subject is composed by the
 * caller/worker at send time and is not tenant-overridable (agent_message uses
 * an approved subject; sla_ops_alert composes its own headline). */
export interface EmailTemplateSubjectSpec {
  defaultText: string;
  tokens: string[];
  /** Extra honesty note the editor surfaces (e.g. "used only as the fallback"). */
  note?: string;
}

export interface EmailTemplateCatalogEntry {
  templateKey: TemplateKey;
  label: string;
  /** One-line description of when the template sends — shown in the editor. */
  description: string;
  subject: EmailTemplateSubjectSpec | null;
  slots: EmailTemplateSlot[];
}

/** The shape the resolver + dispatcher pass into the render path. Undefined ⇒
 * default copy (byte-identical render). */
export interface EmailTemplateOverrides {
  subject?: string;
  slots?: Record<string, string>;
}

/**
 * Substitute `{token}` placeholders in a slot/subject override with the
 * template's data values. Unknown tokens are left verbatim (the API rejects
 * unknown tokens on save, so this only guards a stale override). Deliberately
 * simple + string-only — no expression language, no HTML.
 */
export function interpolateSlot(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = tokens[key];
    return value !== undefined ? value : match;
  });
}

// A shared sign-off + greeting default so the catalog and the JSX fallbacks
// cannot drift. (Kept as string literals in the templates too — this constant
// documents the canonical text.)
const CANDIDATE_SIGN_OFF = "— The {companyName} recruiting team";

export const EMAIL_TEMPLATE_CATALOG: Record<TemplateKey, EmailTemplateCatalogEntry> = {
  "candidate.application_received": {
    templateKey: "candidate.application_received",
    label: "Application received",
    description: "Sent to a candidate immediately after they submit an application.",
    subject: {
      defaultText: "We received your application for {positionTitle}",
      tokens: ["positionTitle"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Application received", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {candidateName},",
        tokens: ["candidateName"],
      },
      {
        slotKey: "intro",
        label: "Intro paragraph",
        defaultText:
          "Thank you for applying to {positionTitle} at {companyName}. Our recruiting team will review your application and reach out within the next few business days if there's a fit.",
        tokens: ["positionTitle", "companyName"],
      },
      {
        slotKey: "noAction",
        label: "No-action line",
        defaultText: "You don't need to do anything right now.",
        tokens: [],
      },
      {
        slotKey: "referenceLine",
        label: "Reference line",
        defaultText: "Reference: {applicationReference}",
        tokens: ["applicationReference"],
      },
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
      {
        slotKey: "footer",
        label: "Footer disclaimer",
        defaultText:
          "This is an automated message. Please don't reply to this email — replies are not monitored. If you need to reach the team, contact the recruiter who emails you next.",
        tokens: [],
      },
    ],
  },

  "candidate.stage_advanced": {
    templateKey: "candidate.stage_advanced",
    label: "Application advanced",
    description: "Sent when an application moves to a candidate-visible stage.",
    subject: {
      defaultText: "Update on your application — {positionTitle}",
      tokens: ["positionTitle"],
    },
    slots: [
      {
        slotKey: "heading",
        label: "Heading",
        defaultText: "Your application has moved forward",
        tokens: [],
      },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {candidateName},",
        tokens: ["candidateName"],
      },
      {
        slotKey: "body",
        label: "Body paragraph",
        defaultText:
          "Your application for {positionTitle} at {companyName} has been advanced to {newStageLabel}.",
        tokens: ["positionTitle", "companyName", "newStageLabel"],
      },
      {
        slotKey: "noActionNote",
        label: "Next-steps line (when there is no action link)",
        defaultText: "The recruiting team will reach out with next steps shortly.",
        tokens: [],
      },
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
    ],
  },

  "candidate.offer_extended": {
    templateKey: "candidate.offer_extended",
    label: "Offer extended",
    description: "Sent to a candidate when an offer is extended (carries the review link).",
    subject: {
      defaultText: "Your offer of employment — {positionTitle} at {companyName}",
      tokens: ["positionTitle", "companyName"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Offer of Employment", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {candidateName},",
        tokens: ["candidateName"],
      },
      {
        slotKey: "intro",
        label: "Intro paragraph",
        defaultText:
          "We're pleased to extend an offer of employment at {companyName} for the role of {positionTitle}.",
        tokens: ["companyName", "positionTitle"],
      },
      {
        slotKey: "reviewLine",
        label: "Review prompt",
        defaultText: "Please review the full offer and confirm your decision below.",
        tokens: [],
      },
      { slotKey: "ctaLabel", label: "Button label", defaultText: "Review & Respond", tokens: [] },
      {
        slotKey: "privateNote",
        label: "Private-link note",
        defaultText:
          "This link is private to you and expires on {expiryAtFormatted}. If you didn't request this offer, please ignore this email.",
        tokens: ["expiryAtFormatted"],
      },
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
    ],
  },

  "candidate.interview_invitation": {
    templateKey: "candidate.interview_invitation",
    label: "Interview invitation",
    description: "Sent to a candidate when a recruiter schedules an interview round.",
    subject: {
      defaultText: "Interview invitation — {roundName} for {positionTitle}",
      tokens: ["roundName", "positionTitle"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Interview Invitation", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {candidateName},",
        tokens: ["candidateName"],
      },
      {
        slotKey: "intro",
        label: "Intro paragraph",
        defaultText:
          "You're invited to the {roundName} round for the {positionTitle} role at {companyName}.",
        tokens: ["roundName", "positionTitle", "companyName"],
      },
      {
        slotKey: "confirmLine",
        label: "Confirm prompt",
        defaultText: "Please confirm your attendance so we can finalise the panel.",
        tokens: [],
      },
      { slotKey: "ctaLabel", label: "Button label", defaultText: "Confirm attendance", tokens: [] },
      {
        slotKey: "privateNote",
        label: "Private-link note",
        defaultText:
          "This link is private to you. If the timing doesn't work, reply to your recruiter to reschedule.",
        tokens: [],
      },
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
    ],
  },

  "candidate.interview_cancelled": {
    templateKey: "candidate.interview_cancelled",
    label: "Interview cancelled",
    description: "Sent to a candidate when a scheduled interview round is cancelled.",
    subject: {
      defaultText: "Your {roundName} interview for {positionTitle} has been cancelled",
      tokens: ["roundName", "positionTitle"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Interview Cancelled", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {candidateName},",
        tokens: ["candidateName"],
      },
      {
        slotKey: "body1",
        label: "Body paragraph 1",
        defaultText:
          "We're writing to let you know that your {roundName} interview for the {positionTitle} role at {companyName} has been cancelled.",
        tokens: ["roundName", "positionTitle", "companyName"],
      },
      {
        slotKey: "body2",
        label: "Body paragraph 2",
        defaultText:
          "This does not affect your standing in the process — you remain an active candidate. Our recruiting team will be in touch shortly with next steps, and if a new time is needed you'll receive a fresh invitation to confirm.",
        tokens: [],
      },
      {
        slotKey: "body3",
        label: "Body paragraph 3",
        defaultText: "If you have any questions in the meantime, simply reply to your recruiter.",
        tokens: [],
      },
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
    ],
  },

  "candidate.account_activation": {
    templateKey: "candidate.account_activation",
    label: "Account activation",
    description:
      "Sent when a candidate requests account activation (carries the set-password link).",
    subject: {
      defaultText: "Activate your {companyName} candidate account",
      tokens: ["companyName"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Activate your account", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {candidateName},",
        tokens: ["candidateName"],
      },
      {
        slotKey: "body",
        label: "Body paragraph",
        defaultText:
          "You can now follow your applications and interviews with {companyName} in one place. Set a password to activate your candidate account.",
        tokens: ["companyName"],
      },
      { slotKey: "ctaLabel", label: "Button label", defaultText: "Set your password", tokens: [] },
      {
        slotKey: "privateNote",
        label: "Private-link note",
        defaultText:
          "This link is private to you and can be used once. If it expires, just request a new one from the sign-in page. If you weren't expecting this, you can safely ignore it.",
        tokens: [],
      },
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
    ],
  },

  "candidate.agent_message": {
    templateKey: "candidate.agent_message",
    label: "Agent message (approved draft)",
    description:
      "Wrapper for an agent-drafted, recruiter-approved message. The body is the approved draft (not overridable); only the sign-off and the fallback subject are.",
    subject: {
      defaultText: "Update on your application — {positionTitle}",
      tokens: ["positionTitle"],
      note: "Used only as a fallback when the approved message carries no subject of its own.",
    },
    slots: [
      {
        slotKey: "signOff",
        label: "Sign-off",
        defaultText: CANDIDATE_SIGN_OFF,
        tokens: ["companyName"],
      },
    ],
  },

  "recruiter.sla_breach_imminent": {
    templateKey: "recruiter.sla_breach_imminent",
    label: "SLA breach imminent (recruiter)",
    description: "Batched heads-up to a recruiter whose applications are near a stage-SLA breach.",
    subject: {
      defaultText: "Heads up — {applicationCount} {noun} near SLA breach",
      tokens: ["applicationCount", "noun"],
    },
    slots: [
      {
        slotKey: "heading",
        label: "Heading",
        defaultText: "Heads up — SLA breach imminent",
        tokens: [],
      },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {recruiterName},",
        tokens: ["recruiterName"],
      },
      {
        slotKey: "body",
        label: "Body paragraph",
        defaultText:
          "You have {applicationCount} {noun} approaching the stage SLA threshold. Quickest path: open the Hot Zone on your triage board.",
        tokens: ["applicationCount", "noun"],
      },
      { slotKey: "ctaLabel", label: "Link label", defaultText: "Open triage", tokens: [] },
      {
        slotKey: "footer",
        label: "Footer note",
        defaultText:
          "You're receiving this because you're a primary recruiter on these requisitions.",
        tokens: [],
      },
    ],
  },

  // Fully worker-composed body (headline / bodyLine / reason / actionLabel are
  // all data). Nothing static to override — subject is the composed headline.
  "recruiter.sla_ops_alert": {
    templateKey: "recruiter.sla_ops_alert",
    label: "SLA operational alert",
    description:
      "Operational alert to an admin-configured recipient. The headline, body, and reason are composed at send time, so there is no static copy to override.",
    subject: null,
    slots: [],
  },

  "recruiter.offer_accepted": {
    templateKey: "recruiter.offer_accepted",
    label: "Offer accepted (recruiter)",
    description: "Sent to the recruiter when a candidate accepts an offer.",
    subject: {
      defaultText: "Offer accepted — {candidateName} for {positionTitle}",
      tokens: ["candidateName", "positionTitle"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Offer accepted", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {recruiterName},",
        tokens: ["recruiterName"],
      },
      {
        slotKey: "body",
        label: "Body paragraph",
        defaultText:
          "{candidateName} accepted the offer for {positionTitle} on {acceptedAtFormatted}. Joining date: {joiningDate}.",
        tokens: ["candidateName", "positionTitle", "acceptedAtFormatted", "joiningDate"],
      },
      {
        slotKey: "workdayNote",
        label: "Follow-up line",
        defaultText: "The Workday Hire event has been queued. Onboarding paperwork follows next.",
        tokens: [],
      },
      { slotKey: "ctaLabel", label: "Link label", defaultText: "Open triage", tokens: [] },
      { slotKey: "signOff", label: "Sign-off", defaultText: "— HireOps", tokens: [] },
    ],
  },

  "recruiter.offer_declined": {
    templateKey: "recruiter.offer_declined",
    label: "Offer declined (recruiter)",
    description: "Sent to the recruiter when a candidate declines an offer.",
    subject: {
      defaultText: "Offer declined — {candidateName} for {positionTitle}",
      tokens: ["candidateName", "positionTitle"],
    },
    slots: [
      { slotKey: "heading", label: "Heading", defaultText: "Offer declined", tokens: [] },
      {
        slotKey: "greeting",
        label: "Greeting",
        defaultText: "Hi {recruiterName},",
        tokens: ["recruiterName"],
      },
      {
        slotKey: "body",
        label: "Body paragraph",
        defaultText:
          "{candidateName} declined the offer for {positionTitle} on {declinedAtFormatted}.",
        tokens: ["candidateName", "positionTitle", "declinedAtFormatted"],
      },
      {
        slotKey: "noReason",
        label: "No-reason line (when the candidate gave no reason)",
        defaultText: "No reason was provided.",
        tokens: [],
      },
      { slotKey: "ctaLabel", label: "Link label", defaultText: "Open triage", tokens: [] },
      { slotKey: "signOff", label: "Sign-off", defaultText: "— HireOps", tokens: [] },
    ],
  },
};

/**
 * Representative SAMPLE DATA per template — used by previewEmailTemplate (so the
 * admin sees exactly what would send) and by the T1.4 test suite. Not seeded
 * anywhere; purely for rendering a realistic preview.
 */
export const EMAIL_TEMPLATE_SAMPLE_DATA: Record<TemplateKey, Record<string, unknown>> = {
  "candidate.application_received": {
    candidateName: "Priya Sharma",
    positionTitle: "Senior Backend Engineer",
    companyName: "Kyndryl",
    applicationReference: "A1B2C3D4",
  },
  "candidate.stage_advanced": {
    candidateName: "Priya Sharma",
    positionTitle: "Senior Backend Engineer",
    companyName: "Kyndryl",
    newStageLabel: "Technical interview",
  },
  "candidate.offer_extended": {
    candidateName: "Priya Sharma",
    companyName: "Kyndryl",
    positionTitle: "Senior Backend Engineer",
    joiningDate: "1 September 2026",
    baseSalaryInrFormatted: "₹42,00,000",
    location: "Bengaluru",
    expiryAtFormatted: "15 August 2026, 6:00 PM IST",
    acceptUrl: "https://portal.example/offer/token",
  },
  "candidate.interview_invitation": {
    candidateName: "Priya Sharma",
    companyName: "Kyndryl",
    positionTitle: "Senior Backend Engineer",
    roundName: "Technical Round 1",
    interviewWhenFormatted: "Monday, 4 Aug 2026, 3:00 PM IST",
    modeLabel: "Video",
    durationMinutes: 60,
    meetingUrl: "https://meet.example/abc",
    confirmUrl: "https://portal.example/interviews/confirm/token",
  },
  "candidate.interview_cancelled": {
    candidateName: "Priya Sharma",
    companyName: "Kyndryl",
    positionTitle: "Senior Backend Engineer",
    roundName: "Technical Round 1",
  },
  "candidate.account_activation": {
    candidateName: "Priya Sharma",
    companyName: "Kyndryl",
    activationUrl: "https://portal.example/candidate/activate/token",
  },
  "candidate.agent_message": {
    candidateName: "Priya Sharma",
    positionTitle: "Senior Backend Engineer",
    companyName: "Kyndryl",
    body: "Hi Priya,\n\nThanks for your patience while we reviewed your application.\n\nBest regards",
    subject: "",
  },
  "recruiter.sla_breach_imminent": {
    recruiterName: "Arjun Mehta",
    applicationCount: 3,
    triageUrl: "https://portal.example/triage",
  },
  "recruiter.sla_ops_alert": {
    headline: "3 applications near SLA breach",
    bodyLine: "Three applications are within 4 hours of breaching their stage SLA.",
    severity: "high",
    actionUrl: "https://portal.example/triage",
    actionLabel: "Open triage",
    reason: "You are configured as an Email Alerts recipient in System Setup.",
  },
  "recruiter.offer_accepted": {
    recruiterName: "Arjun Mehta",
    candidateName: "Priya Sharma",
    positionTitle: "Senior Backend Engineer",
    acceptedAtFormatted: "2 Aug 2026, 11:00 AM IST",
    joiningDate: "1 September 2026",
    triageUrl: "https://portal.example/triage",
  },
  "recruiter.offer_declined": {
    recruiterName: "Arjun Mehta",
    candidateName: "Priya Sharma",
    positionTitle: "Senior Backend Engineer",
    declinedAtFormatted: "2 Aug 2026, 11:00 AM IST",
    triageUrl: "https://portal.example/triage",
  },
};
