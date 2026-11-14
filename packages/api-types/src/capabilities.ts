/**
 * C2-F1 — the PLATFORM capability catalog, the platform default role bundles,
 * and the pure permission resolver (Plan A §2 RL1–RL13 + §15 P5).
 *
 * MODEL
 *   - A CAPABILITY is one distinct permission gate in the API (`area.action`).
 *     The list is fixed by the platform — a tenant cannot invent one, because a
 *     capability only means something if code checks it.
 *   - A ROLE is a label + a bundle of capability grants over a BASE ROLE. The
 *     base role is one of the 12 `tenant_role` enum values and is what goes into
 *     the JWT `roles` claim, so RLS keeps keying off it unchanged.
 *   - Each grant carries a SCOPE (target population, P5): own / team /
 *     business_unit / legal_entity / all. Most capabilities have no natural
 *     population (a settings page, a tenant-wide report) and accept only `all`;
 *     `scopes` on each catalog entry lists what is meaningful.
 *
 * TWO LAYERS
 *   - SYSTEM roles: one per enum role, defined HERE in code (the platform default
 *     layer). Their bundles are exactly the role sets the API gated on before
 *     C2-F1, so every existing member behaves identically. A membership with no
 *     `role_key` gets the UNION of its base roles' system bundles.
 *   - CUSTOM roles: tenant rows (`tenant_roles` + `role_capabilities`, migration
 *     0137). A membership with a `role_key` gets exactly that role's bundle —
 *     nothing from the system bundle of its base role. That is how "admin" stops
 *     being a bypass: an admin-based custom role without `users.admin` cannot
 *     administer users.
 *
 * Capabilities never grant anything across tenants: every resolution is for the
 * caller's own tenant, and RLS tenant isolation is untouched (Plan A §11).
 *
 * Pure zod + constants + functions: shared by the API (enforcement), the portal
 * (nav + page gates) and tests. No I/O here.
 */

import { z } from "zod";

// ─────────────────────────────── scopes ───────────────────────────────

/** Target populations, narrowest first. Order matters: `widerScope` uses it. */
export const CAPABILITY_SCOPES = ["own", "team", "business_unit", "legal_entity", "all"] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];
export const capabilityScopeSchema = z.enum(CAPABILITY_SCOPES);

export const CAPABILITY_SCOPE_LABELS: Record<CapabilityScope, string> = {
  own: "Own records",
  team: "Own + direct reports",
  business_unit: "Own business unit (and below)",
  legal_entity: "Own legal entity",
  all: "Whole organisation",
};

const SCOPE_RANK: Record<CapabilityScope, number> = {
  own: 0,
  team: 1,
  business_unit: 2,
  legal_entity: 3,
  all: 4,
};

/** Does holding `held` cover granting `wanted`? (held is at least as wide.) */
export function scopeCovers(held: CapabilityScope, wanted: CapabilityScope): boolean {
  return SCOPE_RANK[held] >= SCOPE_RANK[wanted];
}

/** The wider of two scopes (used when several system roles grant the same capability). */
export function widerScope(a: CapabilityScope, b: CapabilityScope): CapabilityScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

const ALL_ONLY = ["all"] as const;
const OWN_OR_ALL = ["own", "all"] as const;
const EVERY_SCOPE = CAPABILITY_SCOPES;

// ─────────────────────────────── roles ───────────────────────────────

/**
 * The 12 base roles (mirror of `TENANT_ROLES` in packages/db/src/schema/roles.ts;
 * re-declared so the portal doesn't import drizzle — kept in sync by the parity
 * test).
 */
export const BASE_ROLES = [
  "admin",
  "recruiter",
  "hiring_manager",
  "panel_member",
  "hr_ops",
  "people_ops",
  "it_admin",
  "partner_admin",
  "partner_user",
  "candidate",
  "employee",
  "hr_head",
] as const;
export type BaseRole = (typeof BASE_ROLES)[number];

/** Base roles a tenant custom role may be built on (the internal ones). */
export const CUSTOM_ROLE_BASE_ROLES = [
  "admin",
  "recruiter",
  "hiring_manager",
  "panel_member",
  "hr_ops",
  "people_ops",
  "it_admin",
  "hr_head",
] as const;
export type CustomRoleBaseRole = (typeof CUSTOM_ROLE_BASE_ROLES)[number];

type InternalRole = CustomRoleBaseRole;
type Grants = Partial<Record<InternalRole, CapabilityScope>>;

/** Every internal role at scope `all`. */
const EVERY_INTERNAL: Grants = {
  admin: "all",
  recruiter: "all",
  hiring_manager: "all",
  panel_member: "all",
  hr_ops: "all",
  people_ops: "all",
  it_admin: "all",
  hr_head: "all",
};

/** Shorthand: these roles at scope `all`. */
function all(...roles: InternalRole[]): Grants {
  return Object.fromEntries(roles.map((r) => [r, "all"])) as Grants;
}

// ─────────────────────────────── catalog ───────────────────────────────

export interface CapabilityDef {
  /** Grouping for the admin UI. */
  area: CapabilityArea;
  label: string;
  description: string;
  /** Scopes that are meaningful for this capability (always includes `all`). */
  scopes: readonly CapabilityScope[];
  /**
   * What a narrower-than-`all` scope means for this capability, when it has one
   * (shown in the admin UI and the hand-back). Absent = only `all` exists.
   */
  scopeNote?: string;
  /** PLATFORM DEFAULT grants — exactly the pre-C2-F1 gate's role set. */
  defaults: Grants;
}

export const CAPABILITY_AREAS = [
  "requisitions",
  "candidates",
  "interviews",
  "offers",
  "hr_ops",
  "onboarding",
  "reports",
  "governance",
  "market_intel",
  "partners",
  "organisation",
  "settings",
  "administration",
] as const;
export type CapabilityArea = (typeof CAPABILITY_AREAS)[number];

export const CAPABILITY_AREA_LABELS: Record<CapabilityArea, string> = {
  requisitions: "Requisitions",
  candidates: "Candidates & pipeline",
  interviews: "Interviews & panel",
  offers: "Offers & compensation",
  hr_ops: "HR operations",
  onboarding: "Pre-joining, onboarding & offboarding",
  reports: "Reports & analytics",
  governance: "Governance & diversity",
  market_intel: "Market intelligence",
  partners: "Partners",
  organisation: "Organisation & job architecture",
  settings: "Tenant settings",
  administration: "Administration",
};

/**
 * THE CATALOG. One entry per distinct gate in the API (inventoried from every
 * `requireAnyRole` call site and role-set check at C2-F1). `defaults` is the
 * role set that gate used; the parity test diff-checks it against a frozen copy
 * of the old constants.
 */
export const CAPABILITY_CATALOG = {
  // ── requisitions ──
  "requisitions.read": {
    area: "requisitions",
    label: "Read requisitions",
    description:
      "Requisition list, detail, interview plan and the requisition-scoped candidate list.",
    scopes: EVERY_SCOPE,
    scopeNote:
      "own = requisitions where the member is hiring manager or primary recruiter; team = those of the member and their direct reports; business_unit = the position's business unit is the member's unit or below; legal_entity = the position's business unit belongs to the member's legal entity.",
    defaults: all("admin", "hiring_manager", "recruiter", "hr_head"),
  },
  "requisitions.summaries": {
    area: "requisitions",
    label: "Requisition picker",
    description: "Lean id + title list of requisitions used by pickers (partners, HR ops).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager", "recruiter", "hr_head", "hr_ops"),
  },
  "requisitions.workspace": {
    area: "requisitions",
    label: "Requisitions workspace",
    description: "The Requisitions page in the navigation (recruiter / hiring-manager workspace).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager", "recruiter"),
  },
  "requisitions.write": {
    area: "requisitions",
    label: "Create and edit requisitions",
    description: "Create drafts, generate and review the JD, submit for approval, skill weighting.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager"),
  },
  "requisitions.post": {
    area: "requisitions",
    label: "Post / hold requisitions",
    description: "Take an approved requisition live, put it on hold or resume it.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager", "recruiter"),
  },
  "requisitions.pickers": {
    area: "requisitions",
    label: "Requisition wizard pickers",
    description: "Business units, comp bands and panel pools offered in the requisition wizard.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager", "recruiter"),
  },
  "requisitions.approvals_read": {
    area: "requisitions",
    label: "Requisition approval queue",
    description: "The requisition approval queue and the HR-head dashboard extras.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "requisitions.approve": {
    area: "requisitions",
    label: "Decide requisition approvals",
    description: "Approve or reject a requisition.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "requisitions.owner_dashboard": {
    area: "requisitions",
    label: "Requirement-owner dashboard",
    description: "Hiring-manager dashboard and approval tracker.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager"),
  },
  "requisitions.owner_insights": {
    area: "requisitions",
    label: "Requirement-owner insights",
    description: "JD library, panel setup and hiring insights over requisitions.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only requisitions where the member is the hiring manager.",
    defaults: { admin: "all", hiring_manager: "own" },
  },
  "requisitions.revise": {
    area: "requisitions",
    label: "Rejected-requisition revision suggestions",
    description: "AI revision suggestions for a rejected requisition.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only requisitions where the member is the hiring manager.",
    defaults: { admin: "all", hiring_manager: "own" },
  },
  "requisitions.jd_templates": {
    area: "requisitions",
    label: "JD templates",
    description: "Curate the JD-template library.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager"),
  },

  // ── candidates ──
  "candidates.triage": {
    area: "candidates",
    label: "Recruiter triage",
    description:
      "Triage, candidate lists, shortlist, missing info, bulk move, recruiter brief, candidate messages, pending approvals.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter"),
  },
  "candidates.bulk_upload": {
    area: "candidates",
    label: "Bulk CV upload",
    description: "Upload and retry CV batches against a requisition.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter"),
  },
  "candidates.screening_write": {
    area: "candidates",
    label: "Edit screening answers",
    description: "Edit a candidate's screening answers.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter", "hr_ops"),
  },
  "candidates.comp_read": {
    area: "candidates",
    label: "See candidate pay",
    description: "See (and filter on) a candidate's current / expected CTC.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops", "hr_head", "recruiter"),
  },
  "candidates.assessment_summary": {
    area: "candidates",
    label: "Assessment summary",
    description:
      "Open a candidate's assessment summary (what is shown depends on the next capability).",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter", "hr_ops", "hr_head", "hiring_manager", "panel_member"),
  },
  "candidates.assessment_full": {
    area: "candidates",
    label: "Full assessment view",
    description: "See every panellist's scorecard in the assessment summary.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only on requisitions where the member is the hiring manager.",
    defaults: {
      admin: "all",
      recruiter: "all",
      hr_ops: "all",
      hr_head: "all",
      hiring_manager: "own",
    },
  },
  "candidates.selection_decide": {
    area: "candidates",
    label: "Record selection decisions",
    description: "Record a selection decision on an application.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only on requisitions where the member is the hiring manager.",
    defaults: { admin: "all", recruiter: "all", hiring_manager: "own" },
  },
  "candidates.iris_picker": {
    area: "candidates",
    label: "Iris application picker",
    description: "Search applications from the Iris assistant.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter", "hiring_manager", "hr_ops", "people_ops"),
  },
  "candidates.recruiter_dashboard": {
    area: "candidates",
    label: "Recruiter dashboard",
    description: "Recruiter landing extras (funnel, tasks, follow-ups).",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter"),
  },

  // ── interviews ──
  "interviews.manage": {
    area: "interviews",
    label: "Manage interviews",
    description:
      "Interview plans, scheduling, slots, completion, AI first round, recordings, and other members' availability (view).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager", "recruiter"),
  },
  "interviews.recording_consent": {
    area: "interviews",
    label: "Recording consent desk",
    description: "See recording state and service a consent withdrawal.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hiring_manager", "recruiter", "hr_ops"),
  },
  "interviews.notes_read": {
    area: "interviews",
    label: "Read transcripts and AI notes",
    description: "Read an interview's transcript and AI notes.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only interviews where the member sits on the panel.",
    defaults: { admin: "all", hiring_manager: "all", recruiter: "all", panel_member: "own" },
  },
  "interviews.panel": {
    area: "interviews",
    label: "Panel surface",
    description: "My interviews, interview brief and prep, scorecard submission.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only interviews where the member sits on the panel.",
    defaults: { admin: "all", panel_member: "own" },
  },
  "interviews.panel_pools_write": {
    area: "interviews",
    label: "Manage panel pools",
    description: "Create, rename, staff and archive panel pools.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter"),
  },
  "interviews.availability_admin": {
    area: "interviews",
    label: "Edit others' availability",
    description: "Edit another member's interview availability.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },

  // ── offers / comp ──
  "offers.comp_desk": {
    area: "offers",
    label: "Comp & offer desk",
    description: "Comp analysis, offer drafting, rationale, request offer approval, HR analytics.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops"),
  },
  "offers.approve": {
    area: "offers",
    label: "Decide offer approvals",
    description: "Approve or reject an out-of-band offer.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "offers.comp_bands_write": {
    area: "offers",
    label: "Manage comp bands",
    description: "Create, edit and archive comp bands.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "offers.workday_handoff": {
    area: "offers",
    label: "Workday handoff",
    description: "Download / export the Workday handoff record for an accepted offer.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter", "hr_ops"),
  },

  // ── HR ops ──
  "hr_ops.cases": {
    area: "hr_ops",
    label: "HR cases and HR round",
    description: "HR-ops case list, case detail, HR round scheduling view and assessment.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops"),
  },
  "hr_ops.documents": {
    area: "hr_ops",
    label: "Documents, case audit and policies",
    description: "Request / verify candidate documents, case audit trail, HR policy library.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops"),
  },
  "hr_ops.resolve_recruiter_approvals": {
    area: "hr_ops",
    label: "Resolve recruiter-tier agent approvals",
    description: "Resolve an automation-agent approval routed to recruiters.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter", "hr_ops", "people_ops"),
  },
  "hr_ops.resolve_hr_approvals": {
    area: "hr_ops",
    label: "Resolve HR-team agent approvals",
    description: "Resolve an automation-agent approval routed to the HR team.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops", "people_ops"),
  },

  // ── onboarding ──
  "onboarding.manage": {
    area: "onboarding",
    label: "Onboarding",
    description: "Onboarding cases and assigning learning to a new hire.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter", "hr_ops", "people_ops"),
  },
  "onboarding.offboarding": {
    area: "onboarding",
    label: "Offboarding",
    description: "Initiate and run departures (clearance, assets, settlement, exit interview).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops", "people_ops"),
  },
  "onboarding.prejoining_watchlist": {
    area: "onboarding",
    label: "Joining watchlist",
    description: "Pre-joining watchlist, engagement timeline, risk signals, renege.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = only applications the member owns as recruiter.",
    defaults: { admin: "all", hr_head: "all", recruiter: "own" },
  },
  "onboarding.prejoining_settings": {
    area: "onboarding",
    label: "Pre-joining settings & welcome guide",
    description: "Pre-joining settings, company updates, welcome guide authoring.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "onboarding.learning_admin": {
    area: "onboarding",
    label: "Learning catalogue",
    description: "Curate learning resources, tracks and skill mappings.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },

  // ── reports ──
  "reports.read": {
    area: "reports",
    label: "Reports catalog",
    description: "The /reports catalog (pipeline, aging, headcount, partner scorecard, …).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head", "hr_ops"),
  },
  "reports.hr_metrics": {
    area: "reports",
    label: "HR metrics",
    description: "The HR analytics / metrics surface.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "reports.ask_data": {
    area: "reports",
    label: "Ask your data",
    description: "Ask natural-language questions of the recruiting data.",
    scopes: OWN_OR_ALL,
    scopeNote: "own = answers limited to requisitions where the member is the hiring manager.",
    defaults: {
      admin: "all",
      hr_head: "all",
      hr_ops: "all",
      recruiter: "all",
      hiring_manager: "own",
    },
  },
  "reports.ask_data_candidate_names": {
    area: "reports",
    label: "Candidate names in Ask your data",
    description: "See candidate names on Ask-your-data answers (e.g. declined offers).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head", "hr_ops"),
  },
  "reports.admin": {
    area: "reports",
    label: "Report administration",
    description: "Recruitment report, scheduled report digests, Ask-your-data question log.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },

  // ── governance ──
  "governance.manage": {
    area: "governance",
    label: "Governance & executive audit",
    description:
      "Governance policy, risk flags, executive audit, retention, feedback sharing, screening privacy.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "governance.diversity_slate_view": {
    area: "governance",
    label: "Diverse-slate counts",
    description: "See diverse-slate COUNTS on requisitions (never per-candidate values).",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head", "recruiter"),
  },
  "governance.diversity_settings": {
    area: "governance",
    label: "Diverse-slate settings",
    description: "Edit the tenant's diverse-slate rule.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "governance.audit_log": {
    area: "governance",
    label: "Audit log",
    description: "Read and export the audit log and the notification log.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },

  // ── market intel ──
  "market_intel.read": {
    area: "market_intel",
    label: "Read market benchmarks",
    description: "Market benchmark list.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head", "hiring_manager"),
  },
  "market_intel.write": {
    area: "market_intel",
    label: "Curate market benchmarks",
    description: "Create / update market benchmarks.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "market_intel.feasibility": {
    area: "market_intel",
    label: "Requisition feasibility",
    description: "Generate and read requisition feasibility assessments.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },

  // ── partners ──
  "partners.admin": {
    area: "partners",
    label: "Partner administration",
    description: "Partner orgs, invitations, assignments, MSA, defaults, ownership claims.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_ops"),
  },

  // ── organisation ──
  "organisation.pickers": {
    area: "organisation",
    label: "Organisation pickers",
    description: "Read the active organisation + job architecture for pickers.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head", "hiring_manager", "recruiter"),
  },
  "organisation.read": {
    area: "organisation",
    label: "Organisation admin read",
    description: "Read inactive organisation records, tenant lists and the default country.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "organisation.write": {
    area: "organisation",
    label: "Manage organisation",
    description: "Legal entities, locations, business units, job architecture, tenant lists.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },

  // ── settings ──
  "settings.sla": {
    area: "settings",
    label: "SLA thresholds",
    description: "Read and edit stage SLA thresholds.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "settings.candidate_fields": {
    area: "settings",
    label: "Candidate field policy",
    description: "Required candidate fields per stage.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.email_templates": {
    area: "settings",
    label: "Email templates",
    description: "Email / notification copy overrides.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.interview_templates": {
    area: "settings",
    label: "Interview templates",
    description: "Interview round loops and scorecard rubrics.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  // C2-F12 (merged after C2-F1) — template applicability rules + the
  // resolved-configuration preview. NEW capabilities: the default grants equal
  // F12's own role sets (APPLICABILITY_READ_ROLES / _WRITE_ROLES, now deleted).
  "settings.applicability_read": {
    area: "settings",
    label: "Read applicability rules",
    description:
      "See which template applies to which requisition, test the resolved configuration, list interview loops.",
    scopes: ALL_ONLY,
    defaults: all("admin", "hr_head"),
  },
  "settings.applicability_write": {
    area: "settings",
    label: "Manage applicability rules",
    description: "Create, edit and delete template applicability rules.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.scheduling": {
    area: "settings",
    label: "Scheduling settings",
    description: "Tenant interview scheduling settings.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.sources_read": {
    area: "settings",
    label: "Read sourcing channels",
    description: "Read the sourcing-channel registry.",
    scopes: ALL_ONLY,
    defaults: all("admin", "recruiter"),
  },
  "settings.sources_write": {
    area: "settings",
    label: "Manage sourcing channels",
    description: "Declare, enable and label sourcing channels.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.labels": {
    area: "settings",
    label: "Labels",
    description: "Stage / recommendation labels and role display labels.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.ai": {
    area: "settings",
    label: "AI settings",
    description: "Per-feature AI settings, Iris policy, scoring weights, bias lexicon.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.system": {
    area: "settings",
    label: "System setup",
    description: "Email alerts, escalation, landing pages, shortlist defaults, urgency settings.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.branding": {
    area: "settings",
    label: "Theme & branding",
    description: "Tenant logo, name and brand colours.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.approval_routing": {
    area: "settings",
    label: "Approval routing",
    description: "Approval matrices.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "settings.tenant_config": {
    area: "settings",
    label: "Tenant setup & config transfer",
    description: "Setup wizard and configuration export / import.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },

  // ── administration ──
  "admin.console": {
    area: "administration",
    label: "Admin console",
    description: "The Admin section of the navigation and the admin dashboard.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "admin.users": {
    area: "administration",
    label: "Users",
    description: "Invite members, change their roles, deactivate / reactivate.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "admin.roles": {
    area: "administration",
    label: "Roles & permissions",
    description: "Define custom roles and their capability bundles.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "admin.ai_budget": {
    area: "administration",
    label: "AI budget & costs",
    description: "AI budget, usage and cost views (incl. the AI block of the executive summary).",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "admin.agents": {
    area: "administration",
    label: "Automation agents",
    description: "List, inspect and switch automation agents.",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "admin.integrations": {
    area: "administration",
    label: "Integrations",
    description: "Integration sync logs (Workday).",
    scopes: ALL_ONLY,
    defaults: all("admin"),
  },
  "dashboard.view": {
    area: "administration",
    label: "Home dashboard",
    description: "The persona landing dashboard.",
    scopes: ALL_ONLY,
    defaults: EVERY_INTERNAL,
  },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = keyof typeof CAPABILITY_CATALOG;
export const CAPABILITIES = Object.keys(CAPABILITY_CATALOG) as Capability[];
export const capabilitySchema = z.enum(CAPABILITIES as [Capability, ...Capability[]]);

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);
export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

export function capabilityDef(cap: Capability): CapabilityDef {
  return CAPABILITY_CATALOG[cap];
}

/** Is `scope` meaningful for `cap`? */
export function capabilityAllowsScope(cap: Capability, scope: CapabilityScope): boolean {
  return (CAPABILITY_CATALOG[cap].scopes as readonly CapabilityScope[]).includes(scope);
}

// ─────────────────────────── system bundles ───────────────────────────

/** A capability bundle: capability → scope. */
export type CapabilityBundle = Partial<Record<Capability, CapabilityScope>>;

function buildSystemBundles(): Readonly<Record<BaseRole, CapabilityBundle>> {
  const out = Object.fromEntries(BASE_ROLES.map((r) => [r, {}])) as Record<
    BaseRole,
    CapabilityBundle
  >;
  for (const cap of CAPABILITIES) {
    const defaults = CAPABILITY_CATALOG[cap].defaults as Grants;
    for (const [role, scope] of Object.entries(defaults)) {
      out[role as BaseRole][cap] = scope;
    }
  }
  return out;
}

/** PLATFORM DEFAULT bundle per base role (partner/candidate/employee are empty). */
export const SYSTEM_ROLE_BUNDLES: Readonly<Record<BaseRole, CapabilityBundle>> =
  buildSystemBundles();

/** Base roles whose SYSTEM bundle grants `cap` (Iris action roles, admin UI). */
export function systemRolesWithCapability(cap: Capability): BaseRole[] {
  return BASE_ROLES.filter((r) => SYSTEM_ROLE_BUNDLES[r][cap] !== undefined);
}

export const DEFAULT_SYSTEM_ROLE_LABELS: Record<BaseRole, string> = {
  admin: "Admin",
  recruiter: "Recruiter",
  hiring_manager: "Hiring Manager",
  panel_member: "Panel Member",
  hr_ops: "HR Ops",
  people_ops: "People Ops",
  it_admin: "IT Admin",
  partner_admin: "Partner Admin",
  partner_user: "Partner User",
  candidate: "Candidate",
  employee: "Employee",
  hr_head: "HR Head",
};

// ─────────────────────────── resolution ───────────────────────────

/** A custom role as the resolver needs it. */
export interface CustomRoleGrantSet {
  key: string;
  baseRole: string;
  active: boolean;
  grants: readonly { capability: string; scope: string }[];
}

/**
 * The caller's effective permissions for one tenant. Serialisable (the portal
 * receives it from the server render).
 */
export interface EffectivePermissions {
  /** capability → scope. Absent = not granted. */
  caps: CapabilityBundle;
  /** The custom role key in force, or null when the system bundles apply. */
  roleKey: string | null;
  /**
   * Base roles that CONTRIBUTE each capability (used by the Iris per-role
   * deny-overlay, which is keyed by base role).
   */
  sourceRoles: Partial<Record<Capability, string[]>>;
}

/**
 * Resolve effective permissions.
 *   - `customRole` null → UNION of the system bundles of `roles` (the JWT base
 *     roles), widest scope wins. This is exactly the pre-C2-F1 behaviour.
 *   - `customRole` set → that role's grants ONLY. An inactive role, unknown
 *     capability or a scope the capability doesn't allow is dropped (fail
 *     closed). The base role is the only contributing role.
 */
export function resolveEffectivePermissions(input: {
  roles: readonly string[];
  customRole: CustomRoleGrantSet | null;
}): EffectivePermissions {
  const caps: CapabilityBundle = {};
  const sourceRoles: Partial<Record<Capability, string[]>> = {};

  if (input.customRole) {
    const role = input.customRole;
    if (role.active) {
      for (const g of role.grants) {
        if (!isCapability(g.capability)) continue;
        const parsed = capabilityScopeSchema.safeParse(g.scope);
        if (!parsed.success) continue;
        if (!capabilityAllowsScope(g.capability, parsed.data)) continue;
        caps[g.capability] = parsed.data;
        sourceRoles[g.capability] = [role.baseRole];
      }
    }
    return { caps, roleKey: role.key, sourceRoles };
  }

  for (const r of input.roles) {
    const bundle = (SYSTEM_ROLE_BUNDLES as Record<string, CapabilityBundle | undefined>)[r];
    if (!bundle) continue;
    for (const [cap, scope] of Object.entries(bundle) as [Capability, CapabilityScope][]) {
      const prev = caps[cap];
      caps[cap] = prev ? widerScope(prev, scope) : scope;
      (sourceRoles[cap] ??= []).push(r);
    }
  }
  return { caps, roleKey: null, sourceRoles };
}

/** Does the bundle grant `cap` (at any scope)? */
export function hasCapability(perms: Pick<EffectivePermissions, "caps">, cap: Capability): boolean {
  return perms.caps[cap] !== undefined;
}

/** Any of `caps`? */
export function hasAnyCapability(
  perms: Pick<EffectivePermissions, "caps">,
  caps: readonly Capability[],
): boolean {
  return caps.some((c) => perms.caps[c] !== undefined);
}

/** The granted scope, or null when not granted. */
export function capabilityScope(
  perms: Pick<EffectivePermissions, "caps">,
  cap: Capability,
): CapabilityScope | null {
  return perms.caps[cap] ?? null;
}

// ─────────────────────────── populations ───────────────────────────

/** The facts about the member a population needs (resolved by the API). */
export interface PopulationFacts {
  membershipId: string | null;
  /** Memberships whose manager is this member. */
  directReportIds: readonly string[];
  /** The member's business unit and every unit below it. */
  businessUnitSubtreeIds: readonly string[];
  /** Every business unit of the member's legal entity. */
  legalEntityBusinessUnitIds: readonly string[];
}

/**
 * A resolved target population:
 *   - `all`            no restriction
 *   - `members`        records OWNED by one of these memberships (the meaning of
 *                      ownership is the capability's — HM / recruiter / panellist)
 *   - `business_units` records whose business unit is one of these
 * An empty id list means NOTHING (fail closed: a member with no business unit
 * granted `business_unit` sees no records, never the whole tenant).
 */
export type Population =
  | { kind: "all" }
  | { kind: "members"; membershipIds: string[] }
  | { kind: "business_units"; businessUnitIds: string[] };

export function populationFor(scope: CapabilityScope, facts: PopulationFacts): Population {
  switch (scope) {
    case "all":
      return { kind: "all" };
    case "own":
      return { kind: "members", membershipIds: facts.membershipId ? [facts.membershipId] : [] };
    case "team":
      return {
        kind: "members",
        membershipIds: facts.membershipId
          ? [...new Set([facts.membershipId, ...facts.directReportIds])]
          : [],
      };
    case "business_unit":
      return {
        kind: "business_units",
        businessUnitIds: [...new Set(facts.businessUnitSubtreeIds)],
      };
    case "legal_entity":
      return {
        kind: "business_units",
        businessUnitIds: [...new Set(facts.legalEntityBusinessUnitIds)],
      };
  }
}

/** Is a record with these owner memberships / business unit inside the population? */
export function recordInPopulation(
  pop: Population,
  record: { ownerMembershipIds: readonly (string | null)[]; businessUnitId: string | null },
): boolean {
  switch (pop.kind) {
    case "all":
      return true;
    case "members":
      return record.ownerMembershipIds.some((m) => m !== null && pop.membershipIds.includes(m));
    case "business_units":
      return record.businessUnitId !== null && pop.businessUnitIds.includes(record.businessUnitId);
  }
}

// ─────────────────────────── custom role I/O ───────────────────────────

export const CUSTOM_ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;
export const customRoleKeySchema = z
  .string()
  .regex(CUSTOM_ROLE_KEY_RE, "lowercase letters, digits and _ (2–48), starting with a letter")
  .refine((k) => !(BASE_ROLES as readonly string[]).includes(k), {
    message: "That key is a system role",
  });

export const capabilityGrantSchema = z.object({
  capability: capabilitySchema,
  scope: capabilityScopeSchema,
});
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

/** Every grant's scope must be one its capability allows; no duplicates. */
export function validateGrants(grants: readonly CapabilityGrant[]): string | null {
  const seen = new Set<string>();
  for (const g of grants) {
    if (seen.has(g.capability)) return `Duplicate capability ${g.capability}`;
    seen.add(g.capability);
    if (!capabilityAllowsScope(g.capability, g.scope)) {
      return `Scope "${g.scope}" is not available for ${g.capability}`;
    }
  }
  return null;
}

export const roleRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  baseRole: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  active: z.boolean(),
  grants: z.array(capabilityGrantSchema),
  memberCount: z.number().int(),
});
export type RoleRow = z.infer<typeof roleRowSchema>;

export const capabilityCatalogEntrySchema = z.object({
  key: capabilitySchema,
  area: z.enum(CAPABILITY_AREAS),
  label: z.string(),
  description: z.string(),
  scopes: z.array(capabilityScopeSchema),
  scopeNote: z.string().nullable(),
});
export type CapabilityCatalogEntry = z.infer<typeof capabilityCatalogEntrySchema>;

export function capabilityCatalogEntries(): CapabilityCatalogEntry[] {
  return CAPABILITIES.map((key) => {
    const d = CAPABILITY_CATALOG[key] as CapabilityDef;
    return {
      key,
      area: d.area,
      label: d.label,
      description: d.description,
      scopes: [...d.scopes],
      scopeNote: d.scopeNote ?? null,
    };
  });
}

export const listRolesInputSchema = z.object({}).optional();
export const listRolesOutputSchema = z.object({
  roles: z.array(roleRowSchema),
  catalog: z.array(capabilityCatalogEntrySchema),
});
export type ListRolesOutput = z.infer<typeof listRolesOutputSchema>;

export const ROLE_LABEL_MAX = 60;
export const ROLE_DESCRIPTION_MAX = 400;

export const upsertCustomRoleInputSchema = z.object({
  key: customRoleKeySchema,
  label: z.string().trim().min(1).max(ROLE_LABEL_MAX),
  baseRole: z.enum(CUSTOM_ROLE_BASE_ROLES),
  description: z.string().trim().max(ROLE_DESCRIPTION_MAX).nullable().optional(),
  grants: z.array(capabilityGrantSchema).max(CAPABILITIES.length),
});
export type UpsertCustomRoleInput = z.infer<typeof upsertCustomRoleInputSchema>;
export const upsertCustomRoleOutputSchema = z.object({
  role: roleRowSchema,
  created: z.boolean(),
});

export const setCustomRoleActiveInputSchema = z.object({
  key: customRoleKeySchema,
  active: z.boolean(),
});
export const setCustomRoleActiveOutputSchema = z.object({ ok: z.literal(true) });

/** null → back to the system roles (the membership's `roles` array). */
export const assignMemberRoleInputSchema = z.object({
  membershipId: z.string().uuid(),
  roleKey: customRoleKeySchema.nullable(),
});
export const assignMemberRoleOutputSchema = z.object({
  ok: z.literal(true),
  membershipId: z.string(),
  roleKey: z.string().nullable(),
  roles: z.array(z.string()),
});

export const getMyPermissionsInputSchema = z.object({}).optional();
export const getMyPermissionsOutputSchema = z.object({
  roleKey: z.string().nullable(),
  caps: z.record(z.string(), capabilityScopeSchema),
});
