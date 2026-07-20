/**
 * AppShell — the internal-portal application shell (DESIGN-01).
 *
 * Replaces the old top PortalHeader with a fixed left sidebar + a content
 * column (page-header row + scrollable body). Server-component-friendly, like
 * PortalHeader was: plain props (title / isAdmin / active / user / actions),
 * static anchors, no client hooks — so it renders inside any server component
 * that already knows the session.
 *
 * Layout contract:
 *   - Root is a full-height flex row; the sidebar is a fixed-width column and
 *     the content column owns its own vertical scroll (sidebar never scrolls
 *     away). This is why admin pages that used `min-h-screen` now simply let
 *     the shell manage height.
 *   - Default body wraps `children` in a scroll region; pages bring their own
 *     max-width container (unchanged from today). `fill` opts a page out of
 *     that scroll wrapper so two-pane / full-height surfaces (triage feed,
 *     approvals queue) can manage their own height — they render as a flex
 *     column child that fills the viewport.
 *
 * Candidate/auth surfaces (/t/…, /offer/[token], /privacy, /login) get NO
 * shell.
 */
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import {
  IconHome,
  IconTriage,
  IconApprovals,
  IconOnboarding,
  IconOffboarding,
  IconRequisitions,
  IconSkillWeighting,
  IconReqApprovals,
  IconInterviews,
  IconPanel,
  IconPanelBoard,
  IconMarketIntel,
  IconFeasibility,
  IconHrCases,
  IconHrRounds,
  IconCompOffers,
  IconHrAnalytics,
  IconDocuments,
  IconCaseAudit,
  IconPolicies,
  IconWorkflows,
  IconBranding,
  IconAudit,
  IconCosts,
  IconAiSettings,
  IconReports,
  IconMetrics,
  IconGovernance,
  IconExecAudit,
  IconIntegrations,
  IconUsers,
  IconMissingInfo,
  IconMessaging,
  IconSystemSetup,
  IconBiasShield,
  IconSignOut,
} from "./nav-icons";

export type PortalNavKey =
  | "home"
  | "triage"
  | "candidates"
  | "shortlist"
  | "approvals"
  | "onboarding"
  | "offboarding"
  | "requisitions"
  | "skill-weighting"
  | "requisition-approvals"
  | "approval-tracker"
  | "jd-library"
  | "panel-setup"
  | "insights"
  | "metrics"
  | "governance"
  | "exec-audit"
  | "interviews"
  | "missing-info"
  | "panel"
  | "panel-board"
  | "panel-feedback"
  | "panel-history"
  | "hr-documents"
  | "case-audit"
  | "hr-policies"
  | "market-intelligence"
  | "feasibility"
  | "hr-cases"
  | "hr-rounds"
  | "comp-offers"
  | "hr-analytics"
  | "workflows"
  | "branding"
  | "audit"
  | "costs"
  | "ai-settings"
  | "reports"
  | "integrations"
  | "users"
  // AD-03 admin persona pass
  | "messaging"
  | "system-setup"
  | "bias-shield";

interface NavItem {
  key: PortalNavKey;
  label: string;
  href: string;
  icon: ReactNode;
  /**
   * Persona gate (REQ-01). Omitted → visible to everyone (the pre-existing
   * recruiter surfaces keep their current always-on visibility). When set,
   * the item shows only if the session carries ANY of these roles — or the
   * session is admin, the super-role that sees everything.
   */
  roles?: string[];
}

const MAIN_NAV: NavItem[] = [
  // DASH-01: the persona landing dashboard is Home — first item, all roles.
  { key: "home", label: "Home", href: "/dashboard", icon: <IconHome /> },
  {
    // RBAC-01: Triage is the recruiter's candidate-scoring feed — recruiter +
    // admin (was a legacy un-gated leftover). Matches the listCandidates read.
    key: "triage",
    label: "Triage",
    href: "/triage",
    icon: <IconTriage />,
    roles: ["recruiter", "admin"],
  },
  {
    // RECR-02: the recruiter's grouped-by-role candidates surface + the AI
    // shortlist. recruiter + admin, matching the RECRUITER_SURFACE_ROLES API
    // gate on listCandidatesByRequisition / listShortlist.
    key: "candidates",
    label: "Candidates",
    href: "/candidates",
    icon: <IconUsers />,
    roles: ["recruiter", "admin"],
  },
  {
    key: "shortlist",
    label: "AI Shortlist",
    href: "/shortlist",
    icon: <IconFeasibility />,
    roles: ["recruiter", "admin"],
  },
  {
    // RBAC-01: the agent-draft approval queue — owned by the recruiter
    // (owning_recruiter approves) + admin (was legacy un-gated).
    key: "approvals",
    label: "Approvals",
    href: "/approvals",
    icon: <IconApprovals />,
    roles: ["recruiter", "admin"],
  },
  {
    // RBAC-01: onboarding is worked by the recruiter (day-0) and HR ops —
    // recruiter + hr_ops + people_ops + admin (was legacy un-gated).
    key: "onboarding",
    label: "Onboarding",
    href: "/onboarding",
    icon: <IconOnboarding />,
    roles: ["recruiter", "hr_ops", "people_ops", "admin"],
  },
  {
    // OFFBOARD-03: departures are an HR operation — hr_ops + people_ops + admin
    // only (NOT recruiter). Matches the OFFBOARD_MANAGE_ROLES API gate.
    key: "offboarding",
    label: "Offboarding",
    href: "/offboarding",
    icon: <IconOffboarding />,
    roles: ["hr_ops", "people_ops", "admin"],
  },
  {
    // HROPS-01: the HR-Ops offer-desk workspace — cases post-technical-rounds.
    // hr_ops + admin, matching the HR_OPS_CASE_ROLES API gate.
    key: "hr-cases",
    label: "HR cases",
    href: "/hr-cases",
    icon: <IconHrCases />,
    roles: ["hr_ops", "admin"],
  },
  {
    // HROPS-01: the HR-round scheduler + assessment view. hr_ops + admin.
    key: "hr-rounds",
    label: "HR rounds",
    href: "/hr-rounds",
    icon: <IconHrRounds />,
    roles: ["hr_ops", "admin"],
  },
  {
    key: "requisitions",
    label: "Requisitions",
    href: "/requisitions",
    icon: <IconRequisitions />,
    roles: ["hiring_manager", "recruiter", "admin"],
  },
  {
    // RO-01: the requirement-owner's approval tracker — where their submitted
    // requisitions stand in the approval spine. hiring_manager + admin (the
    // hr_head equivalent is /requisition-approvals, the decision queue).
    key: "approval-tracker",
    label: "Approval tracker",
    href: "/approval-tracker",
    icon: <IconReqApprovals />,
    roles: ["hiring_manager", "admin"],
  },
  {
    // RO-02: standalone skill-weighting surface — hiring_manager (the
    // requirement owner) + admin, matching the listRequisitionsForSkillWeighting
    // API gate.
    key: "skill-weighting",
    label: "Skill weighting",
    href: "/skill-weighting",
    icon: <IconSkillWeighting />,
    roles: ["hiring_manager", "admin"],
  },
  {
    key: "requisition-approvals",
    label: "Req approvals",
    href: "/requisition-approvals",
    icon: <IconReqApprovals />,
    roles: ["hr_head", "admin"],
  },
  // RO-03: the hiring-manager persona surfaces. hiring_manager + admin only,
  // matching the HM_INSIGHTS_ROLES API gate; every read is scoped to the
  // caller's own requisitions.
  {
    key: "jd-library",
    label: "JD library",
    href: "/jd-library",
    icon: <IconDocuments />,
    roles: ["hiring_manager", "admin"],
  },
  {
    key: "panel-setup",
    label: "Panel setup",
    href: "/panel-setup",
    icon: <IconInterviews />,
    roles: ["hiring_manager", "admin"],
  },
  {
    key: "insights",
    label: "Insights",
    href: "/insights",
    icon: <IconHrAnalytics />,
    roles: ["hiring_manager", "admin"],
  },
  {
    // METRICS-01: the HR analytics surface — hr_head (the people-metrics
    // owner) + admin only, matching the getHrMetrics API gate. Lives in the
    // main nav (not Admin) so hr_head, who has no Admin group, can reach it.
    key: "metrics",
    label: "Metrics",
    href: "/metrics",
    icon: <IconMetrics />,
    roles: ["hr_head", "admin"],
  },
  {
    // HRHEAD-03: Policy & Governance — the settings blocks (screening privacy,
    // feedback sharing), the active risk-flag panel + retention reference.
    // hr_head (governance owner) + admin, matching the API gate.
    key: "governance",
    label: "Governance",
    href: "/governance",
    icon: <IconGovernance />,
    roles: ["hr_head", "admin"],
  },
  {
    // HRHEAD-03: Executive Audit — compliance score, KPIs, risk-alert feed +
    // per-stage SLA table. Separate from Governance (audit vs config).
    key: "exec-audit",
    label: "Exec audit",
    href: "/exec-audit",
    icon: <IconExecAudit />,
    roles: ["hr_head", "admin"],
  },
  {
    // HRHEAD-02: the HR-head market-intelligence surface (honest benchmarks).
    // hr_head + admin. hiring_manager can also READ via the API, but the nav
    // item stays HR-head-focused to keep the sidebar lean.
    key: "market-intelligence",
    label: "Market intel",
    href: "/market-intelligence",
    icon: <IconMarketIntel />,
    roles: ["hr_head", "admin"],
  },
  {
    // HRHEAD-02: per-req feasibility (real AI). hr_head + admin.
    key: "feasibility",
    label: "Feasibility",
    href: "/feasibility",
    icon: <IconFeasibility />,
    roles: ["hr_head", "admin"],
  },
  {
    // HROPS-03: pre-offer documents & verification — hr_ops + admin only,
    // matching the HR_OPS_DOC_ROLES API gate.
    key: "hr-documents",
    label: "Documents",
    href: "/hr-documents",
    icon: <IconDocuments />,
    roles: ["hr_ops", "admin"],
  },
  {
    // HROPS-03: per-case audit trail — hr_ops + admin only.
    key: "case-audit",
    label: "Case audit",
    href: "/case-audit",
    icon: <IconCaseAudit />,
    roles: ["hr_ops", "admin"],
  },
  {
    // HROPS-03: curated templates & policies library — hr_ops + admin only.
    key: "hr-policies",
    label: "Policies",
    href: "/hr-policies",
    icon: <IconPolicies />,
    roles: ["hr_ops", "admin"],
  },
  {
    key: "interviews",
    label: "Interviews",
    href: "/interviews",
    icon: <IconInterviews />,
    roles: ["hiring_manager", "recruiter", "admin"],
  },
  {
    // RECR-03: the recruiter's Missing Info Tracker — deterministic
    // required/optional + real stage-gate, four-state chase lifecycle over the
    // REAL candidate-notification flow. recruiter + admin, matching the
    // RECRUITER_SURFACE_ROLES API gate.
    key: "missing-info",
    label: "Missing info",
    href: "/missing-info",
    icon: <IconMissingInfo />,
    roles: ["recruiter", "admin"],
  },
  {
    // INT-03: the interviewer's own surface — distinct from /interviews (the
    // recruiter scheduling surface). panel_member + admin only.
    key: "panel",
    label: "My interviews",
    href: "/panel",
    icon: <IconPanel />,
    roles: ["panel_member", "admin"],
  },
  {
    // PANEL-02: the session board — my interviews as a filterable board.
    // panel_member + admin only. "My interviews" (/panel) stays the card list.
    key: "panel-board",
    label: "All interviews",
    href: "/panel/board",
    icon: <IconPanelBoard />,
    roles: ["panel_member", "admin"],
  },
  {
    // PANEL-01: the panellist's feedback queue (pending + submitted scorecards).
    key: "panel-feedback",
    label: "Feedback",
    href: "/panel/feedback",
    icon: <IconApprovals />,
    roles: ["panel_member", "admin"],
  },
  {
    // PANEL-01: the panellist's past interviews (my scores + recommendations).
    key: "panel-history",
    label: "History",
    href: "/panel/history",
    icon: <IconCaseAudit />,
    roles: ["panel_member", "admin"],
  },
  {
    // HROPS-02: the comp & offer desk — the hr_ops comp operator's surface.
    // hr_ops + admin, matching the listCompDesk API gate.
    key: "comp-offers",
    label: "Comp & offers",
    href: "/comp-offers",
    icon: <IconCompOffers />,
    roles: ["hr_ops", "admin"],
  },
  {
    // HROPS-02: HR analytics — five real charts over the pipeline / offers.
    // hr_ops + admin, matching the getHrAnalytics API gate.
    key: "hr-analytics",
    label: "HR analytics",
    href: "/hr-analytics",
    icon: <IconHrAnalytics />,
    roles: ["hr_ops", "admin"],
  },
];

/**
 * Filter a nav group to the items this session may see. Un-gated items are
 * always visible; gated items need an admin session or a role overlap.
 */
function visibleNav(items: NavItem[], isAdmin: boolean, roles: string[]): NavItem[] {
  return items.filter((item) => {
    if (!item.roles) return true;
    if (isAdmin) return true;
    return item.roles.some((r) => roles.includes(r));
  });
}

const ADMIN_NAV: NavItem[] = [
  { key: "workflows", label: "Workflows", href: "/admin/workflows", icon: <IconWorkflows /> },
  { key: "branding", label: "Theme & branding", href: "/admin/branding", icon: <IconBranding /> },
  { key: "audit", label: "Audit", href: "/admin/audit", icon: <IconAudit /> },
  { key: "costs", label: "Costs", href: "/admin/costs", icon: <IconCosts /> },
  {
    key: "ai-settings",
    label: "AI settings",
    href: "/admin/ai-settings",
    icon: <IconAiSettings />,
  },
  { key: "users", label: "Users & roles", href: "/admin/users", icon: <IconUsers /> },
  { key: "reports", label: "Reports", href: "/admin/reports", icon: <IconReports /> },
  {
    key: "integrations",
    label: "Integrations",
    href: "/admin/integrations",
    icon: <IconIntegrations />,
  },
  // AD-03 — admin persona pass. Honest surfaces: an email delivery log
  // (notification_outbox), system-setup (email alerts + escalation), and the
  // Bias Shield refusal statement (real lexicon posture; no demographic scoring).
  {
    key: "bias-shield",
    label: "Bias Shield",
    href: "/admin/bias-shield",
    icon: <IconBiasShield />,
  },
  { key: "messaging", label: "Messaging", href: "/admin/messaging", icon: <IconMessaging /> },
  {
    key: "system-setup",
    label: "System setup",
    href: "/admin/system-setup",
    icon: <IconSystemSetup />,
  },
];

export interface AppShellUser {
  label: string;
  role?: string;
}

export interface AppShellProps {
  title: string;
  isAdmin: boolean;
  /**
   * The session's tenant roles, used to show persona-gated nav items
   * (REQ-01). Optional + defaults to []: pages that don't pass it simply
   * show the un-gated items (+ the full Admin group when isAdmin) exactly
   * as before — no regression for the existing recruiter surfaces.
   */
  roles?: string[];
  active?: PortalNavKey;
  user: AppShellUser;
  /** Page-level actions rendered on the right of the page-header row. */
  actions?: ReactNode;
  /** Opt out of the default scroll wrapper for full-height / two-pane pages. */
  fill?: boolean;
  children: ReactNode;
}

/** Product wordmark — indigo mark + text, seated on the sidebar brand block.
 * DESIGN-05: the one place a gradient is permitted (a near-tonal dark wash on
 * the brand header), per the restraint rules. */
function Wordmark() {
  return (
    <div className="flex items-center gap-2.5 border-b border-sidebar-border bg-sidebar-brand px-4 py-[1.15rem]">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white shadow-1"
      >
        H
      </span>
      <span className="text-base font-semibold tracking-tight text-sidebar-fg">HireOps</span>
    </div>
  );
}

function NavItemLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-sidebar-active font-medium text-sidebar-active-fg"
          : "font-normal text-sidebar-fg-muted hover:bg-sidebar-elevated hover:text-sidebar-fg",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-accent"
        />
      ) : null}
      <span className={cn("shrink-0", active ? "text-sidebar-accent" : "text-current opacity-80")}>
        {item.icon}
      </span>
      {item.label}
    </a>
  );
}

function NavGroup({
  heading,
  items,
  active,
}: {
  heading?: string;
  items: NavItem[];
  active?: PortalNavKey;
}) {
  return (
    <div className="px-3">
      {heading ? (
        <p className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-sidebar-fg-muted">
          {heading}
        </p>
      ) : null}
      <nav className="flex flex-col gap-0.5">
        {items.map((item) => (
          <NavItemLink key={item.key} item={item} active={active === item.key} />
        ))}
      </nav>
    </div>
  );
}

function UserChip({ user }: { user: AppShellUser }) {
  const initial = (user.label.trim()[0] ?? "?").toUpperCase();
  return (
    <div className="border-t border-sidebar-border p-3">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-elevated text-sm font-medium text-sidebar-fg"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-sidebar-fg">{user.label}</p>
          {user.role ? <p className="truncate text-xs text-sidebar-fg-muted">{user.role}</p> : null}
        </div>
      </div>
      <a
        href="/logout"
        className="mt-1 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-fg-muted transition-colors hover:bg-sidebar-elevated hover:text-sidebar-fg"
      >
        <span className="shrink-0 opacity-80">
          <IconSignOut />
        </span>
        Sign out
      </a>
    </div>
  );
}

function Sidebar({
  isAdmin,
  roles,
  active,
  user,
}: {
  isAdmin: boolean;
  roles: string[];
  active?: PortalNavKey;
  user: AppShellUser;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-fg">
      <Wordmark />
      <div className="flex-1 overflow-y-auto pb-4">
        <NavGroup items={visibleNav(MAIN_NAV, isAdmin, roles)} active={active} />
        {isAdmin ? <NavGroup heading="Admin" items={ADMIN_NAV} active={active} /> : null}
      </div>
      <UserChip user={user} />
    </aside>
  );
}

/** The shared page-header row (title + optional actions), used by both the
 * live shell and the skeleton so the two are pixel-consistent. */
function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-neutral-200 bg-white px-8 py-4 shadow-1">
      <h1 className="text-xl font-semibold tracking-tight text-neutral-900">{title}</h1>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function AppShell({
  title,
  isAdmin,
  roles = [],
  active,
  user,
  actions,
  fill = false,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900">
      <Sidebar isAdmin={isAdmin} roles={roles} active={active} user={user} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title={title} actions={actions} />
        {fill ? (
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        )}
      </div>
    </div>
  );
}

/**
 * AppShellSkeleton — the loading.tsx counterpart. Renders the same shell chrome
 * (identical sidebar width + wordmark + page-header dimensions) with a skeletal
 * nav and user chip, so a client-side navigation swaps only the body content
 * rather than flashing the whole frame. No session needed — it never reveals
 * role-gated nav.
 */
export function AppShellSkeleton({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900">
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-fg">
        <Wordmark />
        <div className="flex-1 space-y-2 px-6 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-sidebar-elevated" />
          ))}
        </div>
        <div className="border-t border-sidebar-border p-3">
          <div className="h-10 animate-pulse rounded-md bg-sidebar-elevated" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title={title} />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
