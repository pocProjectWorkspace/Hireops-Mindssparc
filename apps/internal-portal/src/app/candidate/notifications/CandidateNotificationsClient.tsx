"use client";

import { Card, EmptyState, cn } from "@/components/ui";
import { CandidatePortalShell } from "@/components/candidate/CandidatePortalShell";
import { trpc } from "@/lib/trpc-client";
import { TRPCClientError } from "@trpc/client";
import type { CandidateNotificationCategory, CandidateNotificationRow } from "@hireops/api-types";

/** Compact relative time ("2h ago", "3d ago") from an ISO timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

const CATEGORY_META: Record<
  CandidateNotificationCategory,
  { tint: string; icon: React.ReactNode }
> = {
  interview: { tint: "bg-status-info-50 text-status-info-800", icon: <CalendarIcon /> },
  application: { tint: "bg-brand-50 text-brand-700", icon: <CheckIcon /> },
  offer: { tint: "bg-status-positive-50 text-status-positive-700", icon: <StarIcon /> },
  document: { tint: "bg-status-warning-50 text-status-warning-800", icon: <DocIcon /> },
  account: { tint: "bg-neutral-100 text-neutral-600", icon: <InfoIcon /> },
  general: { tint: "bg-neutral-100 text-neutral-600", icon: <InfoIcon /> },
};

export function CandidateNotificationsClient() {
  const utils = trpc.useUtils();
  const feed = trpc.candidateListMyNotifications.useQuery(undefined, { retry: false });
  const markRead = trpc.candidateMarkNotificationsRead.useMutation({
    onSuccess: () => void utils.candidateListMyNotifications.invalidate(),
  });

  if (feed.isError) {
    const forbidden =
      feed.error instanceof TRPCClientError && feed.error.data?.code === "FORBIDDEN";
    return (
      <CandidatePortalShell active="notifications">
        <Card className="p-6">
          <EmptyState
            title={
              forbidden ? "This isn't a candidate account" : "We couldn't load your notifications"
            }
            hint={forbidden ? "You're signed in, but not as a candidate." : "Please try again."}
          />
        </Card>
      </CandidatePortalShell>
    );
  }

  const items = feed.data?.items ?? [];
  const unread = feed.data?.unreadCount ?? 0;

  return (
    <CandidatePortalShell active="notifications">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              Notifications
            </h1>
            {unread > 0 ? (
              <span className="rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                {unread} new
              </span>
            ) : null}
          </div>
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => markRead.mutate({})}
              disabled={markRead.isPending}
              className="text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 disabled:opacity-50"
            >
              Mark all read
            </button>
          ) : null}
        </div>

        {feed.isLoading ? (
          <Card className="p-6">
            <EmptyState title="Loading notifications…" />
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              title="No notifications yet"
              hint="Interview invitations, application updates, and reminders will show up here."
            />
          </Card>
        ) : (
          <Card className="flex flex-col divide-y divide-neutral-100 p-0">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} />
            ))}
          </Card>
        )}
      </div>
    </CandidatePortalShell>
  );
}

function NotificationRow({ n }: { n: CandidateNotificationRow }) {
  const meta = CATEGORY_META[n.category];
  return (
    <div className={cn("flex items-start gap-3 px-5 py-4", !n.read && "bg-brand-50/40")}>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          meta.tint,
        )}
      >
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-neutral-900">{n.title}</p>
          {!n.read ? (
            <span aria-label="unread" className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />
          ) : null}
        </div>
        {n.body ? <p className="mt-0.5 text-sm text-neutral-600">{n.body}</p> : null}
        <p className="mt-1 text-xs text-neutral-400">{relativeTime(n.createdAt)}</p>
      </div>
    </div>
  );
}

// ── inline category icons ──
function IconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}
function CalendarIcon() {
  return (
    <IconBase>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </IconBase>
  );
}
function CheckIcon() {
  return (
    <IconBase>
      <path d="M20 6 9 17l-5-5" />
    </IconBase>
  );
}
function StarIcon() {
  return (
    <IconBase>
      <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z" />
    </IconBase>
  );
}
function DocIcon() {
  return (
    <IconBase>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v4h4M9 13h6M9 17h6" />
    </IconBase>
  );
}
function InfoIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </IconBase>
  );
}
