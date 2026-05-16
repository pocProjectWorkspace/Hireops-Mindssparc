import type { ListCandidatesOutput } from "@hireops/api-types";

type Candidate = ListCandidatesOutput["rows"][number];

/**
 * Presentational row — no interactivity in Module 1a. Clicks /
 * single-click actions / detail-drawer open / score-explainer all
 * land with Module 1b.
 */
export function TriageRow({ candidate }: { candidate: Candidate }) {
  return (
    <li className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 last:border-b-0">
      <div>
        <p className="font-medium text-neutral-900">{candidate.fullName ?? "(no name)"}</p>
        <p className="text-sm text-neutral-600">{candidate.email ?? "—"}</p>
      </div>
      <div className="flex items-center gap-3 text-sm text-neutral-700">
        <span className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-xs uppercase">
          {candidate.source ?? "unknown"}
        </span>
        <time dateTime={candidate.createdAt} className="font-mono text-xs text-neutral-500">
          {new Date(candidate.createdAt).toLocaleDateString()}
        </time>
      </div>
    </li>
  );
}
