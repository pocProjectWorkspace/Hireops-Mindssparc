import type { PartnerAttentionItem, PartnerAttentionKind } from "@hireops/api-types";
import { Card, EmptyState } from "@/components/ui";

/**
 * AttentionFeed (P1.3) — the dashboard's "Needs your attention" list
 * (partner-wireflows §3.2). Presentational: the API composes every title and
 * detail from stage, date, role title and the partner's own candidate, so this
 * component adds an icon, a relative date and a link and nothing else. There is
 * no client state here — it renders inside the server dashboard.
 */

const KIND_STYLE: Record<PartnerAttentionKind, { ring: string; icon: string }> = {
  new_req: { ring: "bg-brand-50 text-brand-700", icon: "briefcase" },
  stale_submission: { ring: "bg-status-warning-50 text-status-warning-800", icon: "clock" },
  offer_stage: { ring: "bg-status-positive-50 text-status-positive-700", icon: "check" },
  claim_expiring: { ring: "bg-status-error-50 text-status-error-700", icon: "hourglass" },
};

/** One 16px line glyph per kind — inline so the portal adds no icon dependency. */
function KindIcon({ kind }: { kind: PartnerAttentionKind }) {
  const style = KIND_STYLE[kind];
  return (
    <span
      aria-hidden
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${style.ring}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        {style.icon === "briefcase" ? (
          <>
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </>
        ) : null}
        {style.icon === "clock" ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </>
        ) : null}
        {style.icon === "check" ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="m8.5 12.5 2.5 2.5 4.5-5" />
          </>
        ) : null}
        {style.icon === "hourglass" ? (
          <>
            <path d="M7 3h10M7 21h10" />
            <path d="M7 3c0 4 5 5 5 9s-5 5-5 9" />
            <path d="M17 3c0 4-5 5-5 9s5 5 5 9" />
          </>
        ) : null}
      </svg>
    </span>
  );
}

/**
 * "3 days ago" / "in 5 days". Deliberately whole days: an expiry or a stage
 * entry is a date-level fact (the API composes the exact date into the detail
 * line), and an hour-precise "in 4 hours" would imply a precision the
 * exclusivity window doesn't have.
 */
function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.round((then - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

export function AttentionFeed({ items }: { items: PartnerAttentionItem[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight text-neutral-900">
        Needs your attention
      </h2>
      {items.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="Nothing needs your attention."
            hint="New requisitions, submissions that have gone quiet, offers and expiring ownership windows all surface here."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-neutral-100">
            {items.map((item) => (
              <li key={`${item.kind}:${item.href}:${item.occurredAt}`}>
                <a
                  href={item.href}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                >
                  <KindIcon kind={item.kind} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-neutral-900">{item.title}</p>
                    <p className="text-sm text-neutral-500">{item.detail}</p>
                  </div>
                  <span className="shrink-0 pt-0.5 text-sm text-neutral-400">
                    {relativeDay(item.occurredAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
