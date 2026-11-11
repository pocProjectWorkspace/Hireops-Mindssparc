"use client";

import { cn } from "@/components/ui/cn";
import { useModuleFilter } from "@/components/TenantModulesProvider";
import type { NavItem, PortalNavKey } from "./AppShell";

/**
 * Sidebar nav group (moved out of AppShell for C1-F10). A client component so
 * it can read the tenant's module entitlements from TenantModulesProvider and
 * drop items whose module is switched off — AppShell itself stays a server
 * component with plain props. A group left with no visible items renders
 * nothing (heading included).
 */
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

export function NavGroup({
  heading,
  items,
  active,
}: {
  heading?: string;
  items: NavItem[];
  active?: PortalNavKey;
}) {
  const moduleEnabled = useModuleFilter();
  const visible = items.filter((item) => moduleEnabled(item.module));
  if (visible.length === 0) return null;
  return (
    <div className="px-3">
      {heading ? (
        <p className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-sidebar-fg-muted">
          {heading}
        </p>
      ) : null}
      <nav className="flex flex-col gap-0.5">
        {visible.map((item) => (
          <NavItemLink key={item.key} item={item} active={active === item.key} />
        ))}
      </nav>
    </div>
  );
}
