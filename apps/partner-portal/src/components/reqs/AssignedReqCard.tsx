import type { PartnerAssignedRequisitionRow } from "@hireops/api-types";
import { Card, Badge } from "@/components/ui";
import { fmtDate, humanise, reqStatusTone } from "./req-format";

/**
 * One assigned requisition as a card. Lifted verbatim out of PartnerDashboard
 * (P1.1-UI) so the dashboard grid and the /reqs list are literally the same
 * component — a partner should recognise the same card in both places.
 *
 * The title is the way into the detail page; the primary action stays "Submit
 * candidate", because sourcing against the req is what the partner is here to
 * do. Both are plain anchors, so this stays a server component.
 */
export function AssignedReqCard({ req }: { req: PartnerAssignedRequisitionRow }) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight text-neutral-900">
            <a
              href={`/reqs/${req.requisitionId}`}
              className="rounded-sm hover:text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              {req.title}
            </a>
          </h3>
          <p className="mt-0.5 text-sm text-neutral-500">
            {req.location ?? "Location TBC"} ·{" "}
            {req.numberOfOpenings === 1 ? "1 position" : `${req.numberOfOpenings} positions`}
          </p>
        </div>
        <Badge tone={reqStatusTone(req.requisitionStatus)} className="shrink-0 capitalize">
          {humanise(req.requisitionStatus)}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-neutral-500">Opened</dt>
        <dd className="text-right text-neutral-800 tabular-nums">{fmtDate(req.postedAt)}</dd>
        <dt className="text-neutral-500">Target start</dt>
        <dd className="text-right text-neutral-800 tabular-nums">{fmtDate(req.targetStartDate)}</dd>
        <dt className="text-neutral-500">Assigned to you</dt>
        <dd className="text-right text-neutral-800 tabular-nums">{fmtDate(req.assignedAt)}</dd>
      </dl>
      <div className="flex items-center justify-between gap-3 border-t border-neutral-100 pt-3">
        <a
          href={`/reqs/${req.requisitionId}`}
          className="rounded-button px-1 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 hover:underline"
        >
          View details
        </a>
        <a
          href={`/submit?req=${req.requisitionId}`}
          className="inline-flex items-center gap-1.5 rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
        >
          Submit candidate
        </a>
      </div>
    </Card>
  );
}
