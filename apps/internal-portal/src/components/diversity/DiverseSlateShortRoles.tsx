"use client";

import { Card } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-26 — open roles whose diverse slate is short, COUNTS ONLY.
 *
 *   variant="banner" — the shortlist page strip ("2 roles are short of their
 *                      diverse slate: …").
 *   variant="tile"   — the TA / HR dashboard tile listing the short roles.
 *
 * Renders nothing when the tenant has the feature off, when nothing is short,
 * or when the caller lacks a slate-view role (the API answers FORBIDDEN).
 * Never names or links candidates.
 */
export function DiverseSlateShortRoles({ variant }: { variant: "banner" | "tile" }) {
  const q = trpc.listDiverseSlateStatuses.useQuery(
    { onlyShort: true },
    { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
  );
  const data = q.data;
  if (!data?.enabled) return null;
  const rows = data.rows;

  if (variant === "banner") {
    if (rows.length === 0) return null;
    return (
      <PageContainer className="pb-0">
        <div
          role="status"
          className="rounded-card border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-800"
        >
          <p className="font-medium">
            {rows.length === 1
              ? "1 role is short of its diverse slate"
              : `${rows.length} roles are short of their diverse slate`}
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {rows.map((r) => (
              <li key={r.requisitionId}>
                <a href={`/requisitions/${r.requisitionId}`} className="underline">
                  {r.title ?? "Untitled role"}
                </a>{" "}
                {r.diverseInSlate}/{r.requiredMin}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            A reminder only. Counts are candidates who chose to self-identify; nothing here blocks a
            move or an offer.
          </p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="pb-0">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-neutral-900">Diverse slate</h3>
          <span
            className={
              rows.length > 0
                ? "text-xs font-medium text-status-warning-800"
                : "text-xs font-medium text-status-positive-700"
            }
          >
            {rows.length > 0 ? `${rows.length} short` : "All roles met"}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Every open role that requires a diverse slate currently meets its minimum.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-100">
            {rows.map((r) => (
              <li key={r.requisitionId} className="flex items-center justify-between py-2 text-sm">
                <a
                  href={`/requisitions/${r.requisitionId}`}
                  className="truncate text-brand-700 hover:underline"
                >
                  {r.title ?? "Untitled role"}
                </a>
                <span className="shrink-0 tabular-nums text-status-warning-800">
                  {r.diverseInSlate} of {r.requiredMin}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
