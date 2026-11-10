"use client";

import {
  DIVERSE_SLATE_WARN_STAGES,
  diverseSlateLabel,
  type ApplicationStage,
  type DiverseSlateStatus,
  type ListDiverseSlateStatusesOutput,
} from "@hireops/api-types";
import { Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-26 — the diverse-slate flag. COUNTS ONLY: "Diverse slate: 1/2 — short".
 * Never lists which candidates were counted (small-number protection) and
 * renders nothing when the role has no requirement.
 *
 * The API gates every slate read to admin / hr_head / recruiter; for any other
 * caller the query fails FORBIDDEN and these components render nothing.
 */
export function DiverseSlateStatusBadge({
  status,
}: {
  status: Pick<DiverseSlateStatus, "status" | "requiredMin" | "diverseInSlate"> | null | undefined;
}) {
  if (!status) return null;
  const label = diverseSlateLabel(status);
  if (!label) return null;
  return (
    <span title="Candidates in this role's slate who chose to self-identify as diverse, against the role's minimum. Counts only.">
      <Badge tone={status.status === "short" ? "warning" : "success"} pill>
        {label}
      </Badge>
    </span>
  );
}

const QUIET = { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } as const;

/** Badge for one requisition, fetched by id. */
export function DiverseSlateBadge({
  requisitionId,
  enabled = true,
}: {
  requisitionId: string;
  enabled?: boolean;
}) {
  const q = trpc.getDiverseSlateStatus.useQuery({ requisitionId }, { ...QUIET, enabled });
  return <DiverseSlateStatusBadge status={q.data} />;
}

/**
 * One fetch for a whole list page: the open roles that require a diverse
 * slate. Returns a lookup by requisition id (empty when disabled / forbidden).
 */
export function useDiverseSlateMap(enabled = true): Map<string, DiverseSlateStatus> {
  const q = trpc.listDiverseSlateStatuses.useQuery({ onlyShort: false }, { ...QUIET, enabled });
  const map = new Map<string, DiverseSlateStatus>();
  for (const r of (q.data as ListDiverseSlateStatusesOutput | undefined)?.rows ?? []) {
    map.set(r.requisitionId, r);
  }
  return map;
}

/**
 * Non-blocking warning shown where a recruiter moves a candidate into an
 * interview stage or drafts an offer on a role whose slate is short. Never
 * disables the action: the compliance decision stays in the employer's HR
 * system of record.
 */
export function DiverseSlateWarning({
  applicationId,
  action,
}: {
  applicationId: string;
  action: "interview" | "offer";
}) {
  const q = trpc.getDiverseSlateStatus.useQuery({ applicationId }, QUIET);
  const s = q.data;
  if (!s || s.status !== "short") return null;
  return (
    <p
      role="status"
      className="rounded-md border border-status-warning-200 bg-status-warning-50 px-3 py-2 text-xs text-status-warning-800"
    >
      <span className="font-medium">
        Diverse slate short: {s.diverseInSlate} of required {s.requiredMin}.
      </span>{" "}
      {action === "offer"
        ? "You can still draft this offer."
        : "You can still move this candidate forward."}{" "}
      This is a reminder, not a block. Record the compliance decision in your HR system as usual.
    </p>
  );
}

/**
 * Compact pre-action hint for row-level "Advance" buttons: shown only when the
 * NEXT stage is an interview / offer stage and the role's slate is short.
 * Purely informational; the button stays enabled.
 */
export function DiverseSlateMoveHint({
  applicationId,
  nextStage,
}: {
  applicationId: string;
  nextStage: ApplicationStage | null | undefined;
}) {
  const relevant = !!nextStage && DIVERSE_SLATE_WARN_STAGES.includes(nextStage);
  const q = trpc.getDiverseSlateStatus.useQuery({ applicationId }, { ...QUIET, enabled: relevant });
  const s = q.data;
  if (!relevant || !s || s.status !== "short") return null;
  return (
    <span
      className="whitespace-nowrap rounded-full bg-status-warning-50 px-2 py-0.5 text-[11px] font-medium text-status-warning-800"
      title={`Diverse slate short: ${s.diverseInSlate} of required ${s.requiredMin}. A reminder only; you can still advance.`}
    >
      Slate {s.diverseInSlate}/{s.requiredMin}
    </span>
  );
}
