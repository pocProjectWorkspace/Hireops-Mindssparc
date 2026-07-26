"use client";

import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { IconSignOut } from "./nav-icons";
import type { AppShellUser, NavItem, PortalNavKey } from "./AppShell";

/**
 * MobileNav — the small-screen counterpart to the desktop Sidebar. Renders a
 * fixed bottom tab bar (native-app pattern) with the persona's first four
 * visible destinations plus a "More" tab that opens a bottom sheet holding
 * every other destination + the user chip / sign-out. Hidden at `lg` and up,
 * where the Sidebar takes over. Shares the DESIGN-05 slate-ink palette so the
 * bar reads as the same chrome as the desktop rail.
 */

function IconMore() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function BottomTab({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition-colors",
        active ? "text-sidebar-accent" : "text-sidebar-fg-muted active:text-sidebar-fg",
      )}
    >
      <span aria-hidden className="[&_svg]:h-[22px] [&_svg]:w-[22px]">
        {item.icon}
      </span>
      <span className="max-w-full truncate px-0.5 leading-none">{item.label}</span>
    </a>
  );
}

export function MobileNav({
  primary,
  more,
  active,
  user,
}: {
  primary: NavItem[];
  more: NavItem[];
  active?: PortalNavKey;
  user: AppShellUser;
}) {
  const [open, setOpen] = useState(false);
  const moreActive = more.some((i) => i.key === active);
  const initial = (user.label.trim()[0] ?? "?").toUpperCase();

  return (
    <>
      {/* Bottom tab bar — small screens only. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {primary.map((item) => (
          <BottomTab key={item.key} item={item} active={active === item.key} />
        ))}
        {more.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition-colors",
              moreActive ? "text-sidebar-accent" : "text-sidebar-fg-muted active:text-sidebar-fg",
            )}
          >
            <span aria-hidden className="[&_svg]:h-[22px] [&_svg]:w-[22px]">
              <IconMore />
            </span>
            <span className="leading-none">More</span>
          </button>
        ) : null}
      </nav>

      {/* "More" bottom sheet. */}
      {open ? (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="More menu"
        >
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/50"
          />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col overflow-hidden rounded-t-2xl border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)]">
            <div className="flex shrink-0 items-center justify-between border-b border-sidebar-border px-4 py-3">
              <p className="text-sm font-semibold text-sidebar-fg">More</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-md p-1 text-sidebar-fg-muted transition-colors hover:bg-sidebar-elevated hover:text-sidebar-fg"
              >
                <IconClose />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 overflow-y-auto p-3">
              {more.map((item) => (
                <a
                  key={item.key}
                  href={item.href}
                  aria-current={active === item.key ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-3 text-sm transition-colors",
                    active === item.key
                      ? "bg-sidebar-active font-medium text-sidebar-active-fg"
                      : "text-sidebar-fg-muted hover:bg-sidebar-elevated hover:text-sidebar-fg",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "shrink-0 [&_svg]:h-5 [&_svg]:w-5",
                      active === item.key ? "text-sidebar-accent" : "opacity-80",
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </a>
              ))}
            </div>

            <div className="shrink-0 border-t border-sidebar-border p-3">
              <div className="flex items-center gap-2.5 px-2 py-1.5">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-elevated text-sm font-medium text-sidebar-fg"
                >
                  {initial}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-sidebar-fg">{user.label}</p>
                  {user.role ? (
                    <p className="truncate text-xs text-sidebar-fg-muted">{user.role}</p>
                  ) : null}
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
          </div>
        </div>
      ) : null}
    </>
  );
}
