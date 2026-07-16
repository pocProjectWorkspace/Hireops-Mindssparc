import type {
  PartnerGetMeOutput,
  PartnerAssignedRequisitionRow,
  PartnerSubmissionRow,
} from "@hireops/api-types";
import { Card, Badge, StatTile, EmptyState, type BadgeTone } from "@/components/ui";

/**
 * PartnerDashboard — the built surface of the PARTNER-01 shell. Presentational
 * server component fed by the three partnerProcedure reads. Mobile-first: the
 * KPI row and req cards stack to a single column on a phone (partner-wireflows
 * §6.2). Depth that isn't built (submit / messages / commercials) is voiced as
 * honest "coming soon", never faked.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const REQ_STATUS_TONE: Record<string, BadgeTone> = {
  posted: "success",
  approved: "info",
  on_hold: "warning",
  filled: "neutral",
  closed: "neutral",
  cancelled: "error",
  draft: "neutral",
  pending_approval: "info",
};

function AssignedReqCard({ req }: { req: PartnerAssignedRequisitionRow }) {
  const tone = REQ_STATUS_TONE[req.requisitionStatus] ?? "neutral";
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight text-neutral-900">
            {req.title}
          </h3>
          <p className="mt-0.5 text-sm text-neutral-500">
            {req.location ?? "Location TBC"} ·{" "}
            {req.numberOfOpenings === 1 ? "1 position" : `${req.numberOfOpenings} positions`}
          </p>
        </div>
        <Badge tone={tone} className="shrink-0 capitalize">
          {req.requisitionStatus.replace(/_/g, " ")}
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
      <div className="flex items-center justify-end border-t border-neutral-100 pt-3">
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

function ComingSoonPanel({ title, blurb }: { title: string; blurb: string }) {
  return (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-neutral-800">{title}</h3>
        <Badge tone="neutral" className="text-[10px]">
          Soon
        </Badge>
      </div>
      <p className="text-sm text-neutral-500">{blurb}</p>
    </Card>
  );
}

export function PartnerDashboard({
  me,
  reqs,
  submissions,
}: {
  me: PartnerGetMeOutput;
  reqs: PartnerAssignedRequisitionRow[];
  submissions: PartnerSubmissionRow[];
}) {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="flex flex-col gap-8">
      {/* Greeting */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
          Welcome, {me.displayName.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {me.orgName} · {today}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatTile
          label="Assigned reqs"
          value={reqs.length}
          hint={reqs.length === 1 ? "1 open to you" : "open to your org"}
          tone="accent"
        />
        <StatTile
          label="Your submissions"
          value={submissions.length}
          hint={submissions.length === 0 ? "none yet" : "across all reqs"}
        />
        <StatTile label="Commercials" value="—" hint="coming soon" />
      </div>

      {/* Assigned requisitions */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Requisitions open to you
          </h2>
          <span className="text-sm text-neutral-500">
            {reqs.length} {reqs.length === 1 ? "req" : "reqs"}
          </span>
        </div>
        {reqs.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No requisitions assigned yet"
              hint="When Kyndryl opens a role to your organisation, it will appear here. Check back soon or contact your Kyndryl point of contact."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {reqs.map((req) => (
              <AssignedReqCard key={req.assignmentId} req={req} />
            ))}
          </div>
        )}
      </section>

      {/* Submissions */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">
          Your submissions
        </h2>
        {submissions.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No submissions yet"
              hint="Candidate submission ships next. Once it lands, every candidate your team submits will track here with their live stage."
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {submissions.map((s) => (
                <li key={s.claimId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {s.candidateName ?? "Candidate"}
                    </p>
                    <p className="truncate text-sm text-neutral-500">
                      {s.requisitionTitle ?? "Speculative"} · submitted {fmtDate(s.claimedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {s.stage ? (
                      <Badge tone="info" className="capitalize">
                        {s.stage.replace(/_/g, " ")}
                      </Badge>
                    ) : null}
                    <Badge tone="neutral" className="capitalize">
                      {s.status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {/* Coming-soon surface map */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">Coming soon</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ComingSoonPanel
            title="Messages"
            blurb="Message your submitted candidates directly, with content logged and monitored."
          />
          <ComingSoonPanel
            title="Commercials"
            blurb="Track placement fees, invoices and payments against your MSA."
          />
        </div>
      </section>
    </div>
  );
}
