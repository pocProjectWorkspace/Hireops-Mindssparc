/**
 * Iris help mode (IRIS-HELP) — the CURATED capability map.
 *
 * HONESTY. This is hand-authored, maintained content: the ONLY ground truth the
 * help resolver is allowed to answer from. Every entry points at a REAL portal
 * route and, where the user could act now, a REAL whitelisted Iris action id
 * (`relatedActionId` must be an id in the registry). The model selects + phrases
 * from these entries; it is instructed NEVER to invent a route, a menu path, or a
 * capability that is not here. When a question isn't covered by any eligible
 * entry, Iris says so honestly rather than guessing.
 *
 * `roles` gates an entry to the personas who can actually reach that feature
 * (mirrors the nav + action-catalog role model). An entry with an EMPTY roles
 * array is universal (shown to everyone). The help proc filters to the caller's
 * eligible entries before building the prompt, so Iris never explains a feature
 * the user can't use.
 */

export interface CapabilityEntry {
  /** Stable id (used for citation + dedupe). */
  id: string;
  /** Short human title of the feature / task. */
  title: string;
  /** Roles that can reach this; empty = universal. */
  roles: string[];
  /** The real portal route this lives on (for "where do I go"). */
  route?: string;
  /** One-line description of what it's for. */
  summary: string;
  /** The concrete how-to steps, in order. */
  steps: string[];
  /** A whitelisted Iris action id, when Iris can do this for the user right now. */
  relatedActionId?: string;
}

/**
 * The curated map. Grounded in the real nav routes + the 12 registry action ids.
 * Keep entries short and truthful; add one when a new feature/action ships.
 */
export const CAPABILITY_MAP: CapabilityEntry[] = [
  // ── Requisitions ──
  {
    id: "create-requisition",
    title: "Open a new requisition and generate its JD",
    roles: ["hiring_manager", "admin"],
    route: "/requisitions",
    summary: "Start a new open role and let Iris draft the job description.",
    steps: [
      "Go to Requisitions from the left nav.",
      "Use New requisition, or ask Iris to create one with a title and location type.",
      "Iris drafts the JD; you review and submit it for approval.",
    ],
    relatedActionId: "create_requisition_jd",
  },
  {
    id: "requisition-approval-track",
    title: "Track a requisition's approval",
    roles: ["hiring_manager", "recruiter", "admin"],
    route: "/approval-tracker",
    summary: "See where a requisition sits in the approval chain.",
    steps: [
      "Open Approval tracker from the left nav.",
      "Find the requisition to see its current approval stage and who owns the next step.",
    ],
  },
  {
    id: "approve-requisition",
    title: "Approve or reject a requisition",
    roles: ["hr_head", "admin"],
    route: "/requisition-approvals",
    summary: "Review requisitions submitted for HR-head approval and decide.",
    steps: [
      "Open Req approvals from the left nav.",
      "Open a pending requisition, review the details and comp band.",
      "Approve it, or send it back with a reason.",
    ],
  },
  {
    id: "hold-resume-requisition",
    title: "Put a requisition on hold or resume it",
    roles: ["hiring_manager", "recruiter", "admin"],
    route: "/requisitions",
    summary: "Pause hiring on a role, then bring it back when ready.",
    steps: [
      "Ask Iris to hold a requisition (a reason is required) or to resume one that's on hold.",
      "Review the preview and confirm.",
    ],
    relatedActionId: "hold_requisition",
  },
  {
    id: "skill-weighting",
    title: "Tune skill weighting for a role",
    roles: ["hiring_manager", "admin"],
    route: "/skill-weighting",
    summary: "Shape how candidates are scored against a requisition's skills.",
    steps: [
      "Open Skill weighting from the left nav.",
      "Pick the requisition and adjust the weight of each skill.",
    ],
  },
  {
    id: "jd-library",
    title: "Browse the JD library",
    roles: ["hiring_manager", "admin"],
    route: "/jd-library",
    summary: "See every job description across your requisitions.",
    steps: ["Open JD library from the left nav.", "Search or expand a row to read its full JD."],
  },

  // ── Pipeline ──
  {
    id: "triage-candidates",
    title: "Triage incoming candidates",
    roles: ["recruiter", "admin"],
    route: "/triage",
    summary: "Work the freshest applications with AI scores and quick actions.",
    steps: [
      "Open Triage from the left nav.",
      "Review each candidate's AI score and details, then advance or reject.",
    ],
  },
  {
    id: "advance-candidate",
    title: "Advance a candidate to the next stage",
    roles: ["recruiter", "admin"],
    route: "/candidates",
    summary: "Move one candidate forward in the pipeline.",
    steps: [
      "Open the candidate from Candidates or Triage, or ask Iris by name.",
      "Choose the stage to advance to, review the preview and confirm.",
    ],
    relatedActionId: "advance_application",
  },
  {
    id: "reject-candidate",
    title: "Reject a candidate (with a reason)",
    roles: ["recruiter", "admin"],
    route: "/candidates",
    summary: "End one candidate's application; the reason is recorded and shown on their record.",
    steps: [
      "Open the candidate, or ask Iris to reject them by name.",
      "Enter the reason, review the preview and confirm.",
    ],
    relatedActionId: "reject_application",
  },
  {
    id: "bulk-pipeline",
    title: "Advance or reject a whole stage in bulk",
    roles: ["recruiter", "admin"],
    route: "/candidates",
    summary: "Act on every candidate on a requisition currently at a given stage.",
    steps: [
      "Ask Iris to bulk advance or bulk reject on a requisition and stage.",
      "Iris shows the exact set and count; review it and confirm.",
    ],
    relatedActionId: "bulk_advance_applications",
  },
  {
    id: "message-candidate",
    title: "Message a candidate",
    roles: ["recruiter", "admin"],
    route: "/candidates",
    summary: "Send a candidate an email; Iris can draft it from their real context.",
    steps: [
      "Ask Iris to message a candidate and say what it should cover.",
      "Iris drafts a subject and body; edit them, then confirm to send.",
    ],
    relatedActionId: "message_candidate",
  },
  {
    id: "shortlist",
    title: "Review the AI shortlist",
    roles: ["recruiter", "admin"],
    route: "/shortlist",
    summary: "See the AI-ranked shortlist for your roles.",
    steps: [
      "Open AI Shortlist from the left nav.",
      "Review the ranked candidates per requisition.",
    ],
  },
  {
    id: "missing-info",
    title: "Chase missing candidate info",
    roles: ["recruiter", "admin"],
    route: "/missing-info",
    summary: "Find candidates missing required details and request them.",
    steps: [
      "Open Missing info from the left nav.",
      "Open a candidate to request the missing items.",
    ],
  },

  // ── Interviews ──
  {
    id: "cancel-interview",
    title: "Cancel a scheduled interview",
    roles: ["hiring_manager", "recruiter", "admin"],
    route: "/interviews",
    summary: "Cancel an interview; the candidate is notified and it's recorded.",
    steps: [
      "Ask Iris to cancel an interview and pick it from the list.",
      "Enter the reason, review the preview and confirm. Scheduling a new round is a separate step.",
    ],
    relatedActionId: "cancel_interview",
  },
  {
    id: "panel-feedback",
    title: "Submit interview feedback",
    roles: ["panel_member", "admin"],
    route: "/panel",
    summary: "See your assigned interviews and submit structured feedback.",
    steps: [
      "Open your panel dashboard from the left nav.",
      "Open the interview and complete the scorecard.",
    ],
  },

  // ── HR Ops / Onboarding ──
  {
    id: "open-onboarding-case",
    title: "Open an onboarding case",
    roles: ["recruiter", "hr_ops", "people_ops", "admin"],
    route: "/onboarding",
    summary: "Start onboarding for a candidate who has accepted.",
    steps: [
      "Ask Iris to open an onboarding case for the candidate, or start it from Onboarding.",
      "Review the preview and confirm.",
    ],
    relatedActionId: "open_onboarding_case",
  },
  {
    id: "request-documents",
    title: "Request documents from a candidate",
    roles: ["hr_ops", "admin"],
    route: "/hr-cases",
    summary: "Ask a candidate for specific documents.",
    steps: [
      "Ask Iris to request documents for a candidate and choose the document types.",
      "Review the preview and confirm.",
    ],
    relatedActionId: "request_documents",
  },
  {
    id: "request-offer-approval",
    title: "Send an offer for approval",
    roles: ["hr_ops", "admin"],
    route: "/hr-cases",
    summary: "Route an offer to the comp desk for approval.",
    steps: [
      "Ask Iris to request offer approval and pick the offer.",
      "Review the preview and confirm.",
    ],
    relatedActionId: "request_offer_approval",
  },
  {
    id: "hr-cases",
    title: "Work HR cases and rounds",
    roles: ["hr_ops", "admin"],
    route: "/hr-cases",
    summary: "Manage HR cases, rounds and documents in one workspace.",
    steps: ["Open HR cases from the left nav.", "Open a case to see its checklist and documents."],
  },
  {
    id: "offboarding",
    title: "Start or track offboarding",
    roles: ["hr_ops", "people_ops", "admin"],
    route: "/offboarding",
    summary: "Manage separations and settlements.",
    steps: ["Open Offboarding from the left nav.", "Start a new case or open an existing one."],
  },

  // ── Universal ──
  {
    id: "ask-iris",
    title: "What Iris can do for you",
    roles: [],
    summary: "Iris can run real actions you confirm, and help you find your way around.",
    steps: [
      "Click Ask Iris in the top bar.",
      "Use How do I to ask a question, or Do it to have Iris run an action you confirm.",
    ],
  },
];

/**
 * The capability entries a role set may see. An entry with no `roles` is
 * universal; otherwise the caller must carry at least one listed role. Mirrors
 * the nav + action-catalog gate, so Iris only ever explains reachable features.
 */
export function capabilityEntriesForRoles(roles: string[]): CapabilityEntry[] {
  return CAPABILITY_MAP.filter(
    (e) => e.roles.length === 0 || e.roles.some((r) => roles.includes(r)),
  );
}
