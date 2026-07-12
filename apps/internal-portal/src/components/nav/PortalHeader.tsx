/**
 * PortalHeader — the single role-aware header for every internal-portal
 * surface.
 *
 * Consolidates the hand-rolled `border-b` headers that were duplicated
 * across /triage, /approvals, and the /admin/* pages. Renders the page
 * title on the left, the primary nav links next to it, and Sign out on
 * the right. The Admin group (Workflows / Audit / Costs / Reports /
 * Integrations) is only emitted for admins — the pages themselves still guard via
 * requireAdmin, so this is purely to avoid dangling links non-admins
 * can't use.
 *
 * Server-component-friendly by design: it takes plain props (title,
 * isAdmin, active) and renders static anchors — no client hooks. Pages
 * that already know the session pass `isAdmin={session.roles.includes("admin")}`.
 *
 * The active link is highlighted (neutral-900 + medium weight, no
 * underline); inactive links stay muted + underlined, matching the
 * pre-existing house idiom.
 */

export type PortalNavKey =
  | "triage"
  | "approvals"
  | "workflows"
  | "audit"
  | "costs"
  | "reports"
  | "integrations";

interface NavLink {
  key: PortalNavKey;
  label: string;
  href: string;
}

const PRIMARY_LINKS: NavLink[] = [
  { key: "triage", label: "Triage", href: "/triage" },
  { key: "approvals", label: "Approvals", href: "/approvals" },
];

const ADMIN_LINKS: NavLink[] = [
  { key: "workflows", label: "Workflows", href: "/admin/workflows" },
  { key: "audit", label: "Audit", href: "/admin/audit" },
  { key: "costs", label: "Costs", href: "/admin/costs" },
  { key: "reports", label: "Reports", href: "/admin/reports" },
  { key: "integrations", label: "Integrations", href: "/admin/integrations" },
];

function navLinkClass(isActive: boolean): string {
  return isActive
    ? "text-sm font-medium text-neutral-900"
    : "text-sm text-neutral-500 underline hover:text-neutral-900";
}

interface PortalHeaderProps {
  title: string;
  isAdmin: boolean;
  active?: PortalNavKey;
}

export function PortalHeader({ title, isAdmin, active }: PortalHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-semibold text-neutral-900">{title}</h1>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {PRIMARY_LINKS.map((link) => (
            <a key={link.key} href={link.href} className={navLinkClass(active === link.key)}>
              {link.label}
            </a>
          ))}
          {isAdmin ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-2 border-l border-neutral-200 pl-4">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Admin
              </span>
              {ADMIN_LINKS.map((link) => (
                <a key={link.key} href={link.href} className={navLinkClass(active === link.key)}>
                  {link.label}
                </a>
              ))}
            </span>
          ) : null}
        </nav>
      </div>
      <a href="/logout" className="text-sm text-neutral-600 underline hover:text-neutral-900">
        Sign out
      </a>
    </header>
  );
}
