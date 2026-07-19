"use client";

import { useMemo, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@hireops/ui";
import { Card, EmptyState, cn } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { TRPCClientError } from "@trpc/client";
import { IconSignOut } from "@/components/nav/nav-icons";
import { CANDIDATE_NAV, type CandidateNavKey, type CandidateNavItem } from "./candidate-nav";

/**
 * CandidatePortalChrome (CAND-01) — the authenticated candidate portal frame:
 * a DESIGN-05 slate-ink sidebar (neutral tenant brand, candidate nav, sign-out)
 * around a scrollable content column. This is the sidebar the routed candidate
 * pages (Dashboard, Applications, Interviews, Settings — and CAND-02's Profile,
 * Documents, Notifications) all share via <CandidateShell variant="portal">.
 *
 * It resolves the candidate identity itself (candidateGetMe) so every page gets
 * consistent brand + gating for free: a signed-in-but-not-a-candidate identity
 * sees the calm "not a candidate account" screen, exactly as the single-page
 * dashboard did before the split. Child pages that need the person re-query
 * candidateGetMe — react-query serves it from cache (no extra round-trip).
 *
 * NOTE: candidates are an EXTERNAL party. This chrome shows NO internal nav and
 * never surfaces scores/feedback — those live behind the page-level refusals.
 */
export interface CandidatePortalChromeProps {
  /** Which nav item is current. Optional — falls back to pathname matching so
   * CAND-02's pages need not thread it through. */
  active?: CandidateNavKey;
  children: ReactNode;
}

async function signOut(router: ReturnType<typeof useRouter>): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  await supabase.auth.signOut();
  router.replace("/candidate/login");
  router.refresh();
}

/** Derive the active key from the current path when a page didn't pass one.
 * Dashboard ("/candidate") matches exactly; every other item matches a prefix. */
function activeKeyFor(pathname: string | null): CandidateNavKey | undefined {
  if (!pathname) return undefined;
  if (pathname === "/candidate") return "dashboard";
  const hit = CANDIDATE_NAV.find(
    (item) => item.href !== "/candidate" && pathname.startsWith(item.href),
  );
  return hit?.key;
}

function BrandBlock({ brand }: { brand: string }) {
  const initial = (brand.trim()[0] ?? "H").toUpperCase();
  return (
    <div className="flex items-center gap-2.5 border-b border-sidebar-border bg-sidebar-brand px-4 py-[1.15rem]">
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white shadow-1"
      >
        {initial}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-sidebar-fg">{brand}</p>
        <p className="truncate text-[11px] text-sidebar-fg-muted">Candidate portal</p>
      </div>
    </div>
  );
}

function NavLink({ item, active }: { item: CandidateNavItem; active: boolean }) {
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

function UserChip({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
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
          <p className="truncate text-sm font-medium text-sidebar-fg">{name}</p>
          <p className="truncate text-xs text-sidebar-fg-muted">Candidate</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        className="mt-1 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-fg-muted transition-colors hover:bg-sidebar-elevated hover:text-sidebar-fg"
      >
        <span className="shrink-0 opacity-80">
          <IconSignOut />
        </span>
        Sign out
      </button>
    </div>
  );
}

/** A calm full-height frame for the pre-identity states (loading / not a
 * candidate), matching the single-page dashboard's original behaviour. */
function CalmFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export function CandidatePortalChrome({ active, children }: CandidatePortalChromeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });
  const activeKey = active ?? activeKeyFor(pathname);

  const nav = useMemo(
    () => CANDIDATE_NAV.map((item) => ({ item, active: item.key === activeKey })),
    [activeKey],
  );

  if (me.isLoading) {
    return (
      <CalmFrame>
        <Card className="my-auto">
          <EmptyState title="Loading your portal…" />
        </Card>
      </CalmFrame>
    );
  }

  if (me.isError || !me.data) {
    const forbidden = me.error instanceof TRPCClientError && me.error.data?.code === "FORBIDDEN";
    return (
      <CalmFrame>
        <Card className="my-auto">
          <EmptyState
            title={forbidden ? "This isn't a candidate account" : "We couldn't load your portal"}
            hint={
              forbidden
                ? "You're signed in, but not as a candidate. If you applied for a role, activate your candidate account from the sign-in page."
                : "Please try again in a moment."
            }
            action={
              <Button variant="secondary" onClick={() => void signOut(router)}>
                Sign out
              </Button>
            }
          />
        </Card>
      </CalmFrame>
    );
  }

  const person = me.data;
  const brand = person.tenantDisplayName;

  return (
    <div className="flex min-h-screen bg-neutral-50 text-neutral-900 md:h-screen md:overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-fg md:flex">
        <BrandBlock brand={brand} />
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <nav className="flex flex-col gap-0.5 pt-3">
            {nav.map(({ item, active: isActive }) => (
              <NavLink key={item.key} item={item} active={isActive} />
            ))}
          </nav>
        </div>
        <UserChip name={person.fullName} onSignOut={() => void signOut(router)} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar + horizontal nav */}
        <div className="border-b border-sidebar-border bg-sidebar text-sidebar-fg md:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
              >
                {(brand.trim()[0] ?? "H").toUpperCase()}
              </span>
              <span className="truncate text-sm font-semibold text-sidebar-fg">{brand}</span>
            </div>
            <button
              type="button"
              onClick={() => void signOut(router)}
              className="text-xs font-medium text-sidebar-fg-muted underline"
            >
              Sign out
            </button>
          </div>
          <div className="flex gap-1 overflow-x-auto px-3 pb-2">
            {nav.map(({ item, active: isActive }) => (
              <a
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-active text-sidebar-active-fg"
                    : "text-sidebar-fg-muted hover:bg-sidebar-elevated hover:text-sidebar-fg",
                )}
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
