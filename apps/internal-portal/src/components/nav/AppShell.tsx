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
  IconTriage,
  IconApprovals,
  IconOnboarding,
  IconOffboarding,
  IconRequisitions,
  IconReqApprovals,
  IconInterviews,
  IconPanel,
  IconWorkflows,
  IconAudit,
  IconCosts,
  IconAiSettings,
  IconReports,
  IconIntegrations,
  IconUsers,
  IconSignOut,
} from "./nav-icons";

export type PortalNavKey =
  | "triage"
  | "approvals"
  | "onboarding"
  | "offboarding"
  | "requisitions"
  | "requisition-approvals"
  | "interviews"
  | "panel"
  | "workflows"
  | "audit"
  | "costs"
  | "ai-settings"
  | "reports"
  | "integrations"
  | "users";

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
  { key: "triage", label: "Triage", href: "/triage", icon: <IconTriage /> },
  { key: "approvals", label: "Approvals", href: "/approvals", icon: <IconApprovals /> },
  { key: "onboarding", label: "Onboarding", href: "/onboarding", icon: <IconOnboarding /> },
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
    key: "requisitions",
    label: "Requisitions",
    href: "/requisitions",
    icon: <IconRequisitions />,
    roles: ["hiring_manager", "recruiter", "admin"],
  },
  {
    key: "requisition-approvals",
    label: "Req approvals",
    href: "/requisition-approvals",
    icon: <IconReqApprovals />,
    roles: ["hr_head", "admin"],
  },
  {
    key: "interviews",
    label: "Interviews",
    href: "/interviews",
    icon: <IconInterviews />,
    roles: ["hiring_manager", "recruiter", "admin"],
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

/** Product wordmark — indigo mark + text. Text-only per the ticket, styled. */
function Wordmark() {
  return (
    <div className="flex items-center gap-2 px-4 py-5">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
      >
        H
      </span>
      <span className="text-base font-semibold tracking-tight text-neutral-900">HireOps</span>
    </div>
  );
}

function navItemClass(active: boolean): string {
  return cn(
    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
    active
      ? "bg-brand-50 font-medium text-brand-700"
      : "font-normal text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
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
        <p className="px-3 pb-1.5 pt-4 text-xs font-medium uppercase tracking-wide text-neutral-400">
          {heading}
        </p>
      ) : null}
      <nav className="flex flex-col gap-0.5">
        {items.map((item) => (
          <a key={item.key} href={item.href} className={navItemClass(active === item.key)}>
            <span className="shrink-0 text-current opacity-80">{item.icon}</span>
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

function UserChip({ user }: { user: AppShellUser }) {
  const initial = (user.label.trim()[0] ?? "?").toUpperCase();
  return (
    <div className="border-t border-neutral-200 p-3">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-medium text-neutral-600"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-800">{user.label}</p>
          {user.role ? <p className="truncate text-xs text-neutral-500">{user.role}</p> : null}
        </div>
      </div>
      <a
        href="/logout"
        className="mt-1 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
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
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white">
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
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-neutral-200 bg-white px-8 py-4">
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
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white">
        <Wordmark />
        <div className="flex-1 space-y-2 px-6 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-neutral-100" />
          ))}
        </div>
        <div className="border-t border-neutral-200 p-3">
          <div className="h-10 animate-pulse rounded-md bg-neutral-100" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title={title} />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
