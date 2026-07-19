"use client";

// ─────────────────────────────────────────────────────────────────────────
// CAND-02 STUB — CAND-01 owns the real routed portal shell (union seam;
// orchestrator keeps CAND-01's at merge).
//
// This is DELIBERATELY a SEPARATE file from components/candidate/CandidateShell.tsx
// on purpose: CandidateShell.tsx is the shared *public* centred-page chrome used
// by 8 pages (apply / offer / privacy / activate / login / interview-confirm),
// and overwriting it would break those pages. This stub gives the CAND-02
// Profile / Documents / Notifications pages a sidebar shell to render inside so
// they build standalone. At merge, DISCARD this file and re-point the three
// CAND-02 page clients at CAND-01's real shell (one import line each).
// ─────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

export type CandidateNavKey =
  | "dashboard"
  | "profile"
  | "applications"
  | "interviews"
  | "documents"
  | "notifications"
  | "settings";

interface NavItem {
  key: CandidateNavKey;
  label: string;
  href: string;
  icon: ReactNode;
}

// Deliberately NO "AI Assistant" item — the prototype's candidate AI coach is a
// standing refusal (no AI chatbot for candidates). Honest omission.
const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/candidate", icon: <GridIcon /> },
  { key: "profile", label: "My Profile", href: "/candidate/profile", icon: <UserIcon /> },
  {
    key: "applications",
    label: "Applications",
    href: "/candidate/applications",
    icon: <DocIcon />,
  },
  { key: "interviews", label: "Interviews", href: "/candidate/interviews", icon: <VideoIcon /> },
  { key: "documents", label: "Documents", href: "/candidate/documents", icon: <FolderIcon /> },
  {
    key: "notifications",
    label: "Notifications",
    href: "/candidate/notifications",
    icon: <BellIcon />,
  },
  { key: "settings", label: "Settings", href: "/candidate/settings", icon: <GearIcon /> },
];

export interface CandidatePortalShellProps {
  active: CandidateNavKey;
  /** Page title shown in the top bar's welcome line. */
  children: ReactNode;
}

export function CandidatePortalShell({ active, children }: CandidatePortalShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });

  const brand = me.data?.tenantDisplayName ?? "Candidate Portal";
  const name = me.data?.fullName ?? "there";
  const initial = name.trim()[0]?.toUpperCase() ?? "C";

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/candidate/login");
  }

  return (
    <div className="flex min-h-screen bg-neutral-50 text-neutral-900">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-fg">
        <div className="flex items-center gap-2.5 border-b border-sidebar-border bg-sidebar-brand px-4 py-[1.15rem]">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white shadow-1"
          >
            {brand.trim()[0]?.toUpperCase() ?? "H"}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-sidebar-fg">{brand}</p>
            <p className="truncate text-[11px] text-sidebar-fg-muted">Candidate Portal</p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
          {NAV.map((item) => {
            const isActive = item.key === active || pathname === item.href;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-active font-medium text-sidebar-active-fg"
                    : "font-normal text-sidebar-fg-muted hover:bg-sidebar-elevated hover:text-sidebar-fg",
                )}
              >
                {isActive ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-accent"
                  />
                ) : null}
                <span
                  className={cn(
                    "shrink-0",
                    isActive ? "text-sidebar-accent" : "text-current opacity-80",
                  )}
                >
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-elevated text-sm font-medium text-sidebar-fg">
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-sidebar-fg">{name}</p>
              <p className="truncate text-xs text-sidebar-fg-muted">Candidate Portal</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-1 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-fg-muted transition-colors hover:bg-sidebar-elevated hover:text-sidebar-fg"
          >
            <SignOutIcon />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold tracking-tight text-neutral-900">
              Welcome, {name.split(" ")[0]}
            </p>
            <p className="truncate text-xs text-neutral-500">Candidate Portal</p>
          </div>
          <Link
            href="/candidate/notifications"
            aria-label="Notifications"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700"
          >
            <BellIcon />
          </Link>
        </header>

        <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}

// ── minimal stroke icons (inline; the real shell will supply its own) ──
function IconBase({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}
function GridIcon() {
  return (
    <IconBase>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </IconBase>
  );
}
function UserIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </IconBase>
  );
}
function DocIcon() {
  return (
    <IconBase>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v4h4" />
      <path d="M9 13h6M9 17h6" />
    </IconBase>
  );
}
function VideoIcon() {
  return (
    <IconBase>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M15 10l6-3v10l-6-3z" />
    </IconBase>
  );
}
function FolderIcon() {
  return (
    <IconBase>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </IconBase>
  );
}
function BellIcon() {
  return (
    <IconBase>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </IconBase>
  );
}
function GearIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </IconBase>
  );
}
function SignOutIcon() {
  return (
    <IconBase>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </IconBase>
  );
}
