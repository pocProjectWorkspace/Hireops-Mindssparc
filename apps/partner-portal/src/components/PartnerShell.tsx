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
 * The surface map (partner-wireflows §2) has Dashboard / Reqs / Submit
 * Candidate / Messages / Commercials. Dashboard + Submit candidate ship
 * (PARTNER-01 + PARTNER-02); the rest carry an honest "Soon" badge and are
 * non-interactive, so the nav tells the true story of what's built without
 * pretending.
 */

export type PartnerNavKey = "dashboard" | "submit" | "messages" | "commercials";

interface NavItem {
  key: PartnerNavKey;
  label: string;
  href?: string;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  { key: "submit", label: "Submit candidate", href: "/submit" },
  { key: "messages", label: "Messages", soon: true },
  { key: "commercials", label: "Commercials", soon: true },
];

export interface PartnerShellUser {
  label: string;
  role?: string;
}

export interface PartnerShellProps {
  orgName: string;
  user: PartnerShellUser;
  active?: PartnerNavKey;
  children: ReactNode;
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
      >
        H
      </span>
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

function NavRow({ active }: { active?: PartnerNavKey }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 border-t border-neutral-200 bg-white px-4 py-2 sm:px-6">
      {NAV.map((item) => {
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

export function PartnerShell({ orgName, user, active, children }: PartnerShellProps) {
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
        <NavRow active={active} />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
