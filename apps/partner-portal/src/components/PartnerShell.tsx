import type { ReactNode } from "react";
import { cn, Badge } from "@/components/ui";

/**
 * PartnerShell — the partner-portal application shell (PARTNER-01).
 *
 * Deliberately a top-bar layout rather than the internal portal's fixed
 * sidebar: partners work on the move (partner-wireflows §6.2 mobile note), so
 * a top bar + wrapping nav row collapses cleanly to a phone. Server-component
 * friendly — plain props, static anchors, no client hooks — so it renders
 * inside the dashboard server component that already resolved the session.
 *
 * The surface map (partner-wireflows §2) has Dashboard / Reqs / Submissions /
 * Submit Candidate / Team / Messages / Commercials. All but Messages ship
 * (PARTNER-01 + PARTNER-02 + P1.1 + P1.2 + P1.3 + P2.2); Messages carries an
 * honest "Soon" badge and is non-interactive, so the nav tells the true story
 * of what's built without pretending.
 *
 * Team and Commercials are the ROLE-dependent entries — §3.12 and §3.11 are
 * both partner-org-admin only — and they share one boolean, `isOrgAdmin`,
 * passed the same way `user` is from the partnerGetMe() every page already
 * has in hand. (It was `canManageTeam` until P2.2 gave it a second consumer;
 * one flag with an honest name beats two spellings of the same fact.) It is
 * nav hygiene, not access control: both pages and every procedure behind them
 * enforce partner_admin server-side regardless.
 */

export type PartnerNavKey =
  | "dashboard"
  | "reqs"
  | "submissions"
  | "submit"
  | "team"
  | "messages"
  | "commercials";

interface NavItem {
  key: PartnerNavKey;
  label: string;
  href?: string;
  soon?: boolean;
  /** Rendered only for a partner_admin. */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  { key: "reqs", label: "Reqs", href: "/reqs" },
  { key: "submissions", label: "Submissions", href: "/submissions" },
  { key: "submit", label: "Submit candidate", href: "/submit" },
  { key: "team", label: "Team", href: "/team", adminOnly: true },
  { key: "commercials", label: "Commercials", href: "/commercials", adminOnly: true },
  { key: "messages", label: "Messages", soon: true },
];

export interface PartnerShellUser {
  label: string;
  role?: string;
}

export interface PartnerShellProps {
  orgName: string;
  user: PartnerShellUser;
  active?: PartnerNavKey;
  /** partnerGetMe().role === "partner_admin" — shows Team and Commercials. */
  isOrgAdmin?: boolean;
  children: ReactNode;
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      {/* Mark only — "Partners" has to stay live text alongside it, so the
          lockup's own wordmark would compete with it. */}
      <img
        src="/logo/hireops-mark.png"
        alt=""
        aria-hidden
        width={28}
        height={28}
        className="h-7 w-7 shrink-0 object-contain"
      />
      <span className="text-base font-semibold tracking-tight text-neutral-900">
        HireOps <span className="font-normal text-neutral-500">Partners</span>
      </span>
    </div>
  );
}

function UserChip({ user }: { user: PartnerShellUser }) {
  const initial = (user.label.trim()[0] ?? "?").toUpperCase();
  return (
    <div className="flex items-center gap-2.5">
      <div className="hidden min-w-0 text-right sm:block">
        <p className="truncate text-sm font-medium text-neutral-800">{user.label}</p>
        {user.role ? <p className="truncate text-xs text-neutral-500">{user.role}</p> : null}
      </div>
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-medium text-neutral-600"
      >
        {initial}
      </span>
      <a
        href="/logout"
        className="rounded-md px-2.5 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
      >
        Sign out
      </a>
    </div>
  );
}

function NavRow({ active, isOrgAdmin }: { active?: PartnerNavKey; isOrgAdmin?: boolean }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 border-t border-neutral-200 bg-white px-4 py-2 sm:px-6">
      {NAV.filter((item) => !item.adminOnly || isOrgAdmin).map((item) => {
        const isActive = active === item.key;
        if (item.soon) {
          return (
            <span
              key={item.key}
              aria-disabled
              className="flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-neutral-400"
              title="Coming soon"
            >
              {item.label}
              <Badge tone="neutral" className="text-[10px]">
                Soon
              </Badge>
            </span>
          );
        }
        return (
          <a
            key={item.key}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              isActive
                ? "bg-brand-50 font-medium text-brand-700"
                : "font-normal text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
            )}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

export function PartnerShell({ orgName, user, active, isOrgAdmin, children }: PartnerShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="sticky top-0 z-10 bg-white">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Wordmark />
            <span className="hidden h-5 w-px bg-neutral-200 sm:block" aria-hidden />
            <Badge tone="accent" className="max-w-[45vw] truncate sm:max-w-none">
              {orgName}
            </Badge>
          </div>
          <UserChip user={user} />
        </div>
        <NavRow active={active} isOrgAdmin={isOrgAdmin} />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
