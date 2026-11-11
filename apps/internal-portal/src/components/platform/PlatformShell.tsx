import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { PageContainer } from "@/components/nav/PageContainer";

/**
 * C1-F10 — chrome for the platform console (/platform). Deliberately NOT the
 * tenant AppShell: an operator is outside every tenant, and nothing here
 * carries tenant navigation, branding or Iris. Server component, plain props.
 */
export type PlatformNavKey = "tenants" | "health";

const NAV: { key: PlatformNavKey; label: string; href: string }[] = [
  { key: "tenants", label: "Tenants", href: "/platform" },
  { key: "health", label: "Health", href: "/platform/health" },
];

export function PlatformShell({
  title,
  active,
  operator,
  children,
}: {
  title: string;
  active: PlatformNavKey;
  operator: { email: string; role: string };
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-sidebar-border bg-sidebar text-sidebar-fg">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-8">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold tracking-tight">
              HireOps <span className="font-normal text-sidebar-fg-muted">Platform</span>
            </span>
            <nav aria-label="Platform" className="flex gap-1">
              {NAV.map((item) => (
                <a
                  key={item.key}
                  href={item.href}
                  aria-current={active === item.key ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    active === item.key
                      ? "bg-sidebar-active font-medium text-sidebar-active-fg"
                      : "text-sidebar-fg-muted hover:bg-sidebar-elevated hover:text-sidebar-fg",
                  )}
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-xs text-sidebar-fg-muted">
            <span>
              {operator.email} · {operator.role}
            </span>
            <a href="/logout" className="rounded-md px-2 py-1 hover:bg-sidebar-elevated">
              Sign out
            </a>
          </div>
        </div>
      </header>
      <PageContainer>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-6 text-sm text-neutral-500">
          Tenant metadata only. Candidate and requisition content is not visible here.
        </p>
        {children}
      </PageContainer>
    </div>
  );
}

export function TenantStatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-status-positive-50 text-status-positive-700"
      : status === "provisioning"
        ? "bg-status-info-50 text-status-info-800"
        : status === "suspended"
          ? "bg-status-warning-50 text-status-warning-800"
          : "bg-status-error-50 text-status-error-700";
  return (
    <span className={cn("inline-flex rounded px-2 py-0.5 text-xs font-medium", tone)}>
      {status}
    </span>
  );
}
