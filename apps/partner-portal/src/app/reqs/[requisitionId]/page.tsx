import type { ReactNode } from "react";
import { TRPCError } from "@trpc/server";
import type { PartnerGetRequisitionDetailOutput } from "@hireops/api-types";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { fmtCompBand, fmtDate, humanise, reqStatusTone } from "@/components/reqs/req-format";
import { Badge, Card, EmptyState } from "@/components/ui";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * /reqs/<id> — the full requisition a partner sources against (P1.1,
 * partner-wireflows §3.4): logistics, comp band, the locked JD, and every
 * knockout question, ending in the route to submitting a candidate.
 *
 * Authorization is entirely the API's: partnerGetRequisitionDetail raises the
 * SAME FORBIDDEN for a req in another tenant, a req assigned to somebody else,
 * and a req that doesn't exist, so a partner cannot probe what Kyndryl has
 * open. This page therefore renders one calm notice for all three rather than
 * distinguishing them — distinguishing them would leak exactly what the API
 * refuses to. A malformed id (zod BAD_REQUEST) gets the same treatment: it is,
 * by definition, not a req assigned to you.
 */
export default async function RequisitionDetailPage({
  params,
}: {
  params: { requisitionId: string };
}) {
  const session = await requireAuth();
  const caller = createPartnerServerTRPCCaller(session);

  let me;
  try {
    me = await caller.partnerGetMe();
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") {
      return <NotAPartner email={session.email} />;
    }
    throw err;
  }

  const shellProps = {
    orgName: me.orgName,
    user: { label: me.displayName, role: roleLabel(me.role) },
    active: "reqs" as const,
    isOrgAdmin: me.role === "partner_admin",
  };

  let req: PartnerGetRequisitionDetailOutput;
  try {
    req = await caller.partnerGetRequisitionDetail({ requisitionId: params.requisitionId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "BAD_REQUEST")) {
      return (
        <PartnerShell {...shellProps}>
          <Card padded={false}>
            <EmptyState
              title="This requisition isn't assigned to your organisation."
              hint="It may have been withdrawn from your org, or the link may be out of date. Your assigned roles are all listed on the Reqs page."
              action={
                <a
                  href="/reqs"
                  className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                >
                  Back to your reqs
                </a>
              }
            />
          </Card>
        </PartnerShell>
      );
    }
    throw err;
  }

  const submitHref = `/submit?req=${req.requisitionId}`;

  return (
    <PartnerShell {...shellProps}>
      <div className="flex flex-col gap-6">
        <a href="/reqs" className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline">
          ← All requisitions
        </a>

        {/* Header — what the role is, and where it stands */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-neutral-900">{req.title}</h1>
              <p className="mt-1 text-sm text-neutral-500">
                {req.primaryLocation ?? "Location TBC"} · {humanise(req.locationType)} ·{" "}
                {req.numberOfOpenings === 1 ? "1 position" : `${req.numberOfOpenings} positions`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={reqStatusTone(req.status)} className="capitalize">
                {humanise(req.status)}
              </Badge>
              <a
                href={submitHref}
                className="inline-flex items-center rounded-button bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
              >
                Submit candidate
              </a>
            </div>
          </div>

          <Card>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Level">{req.level ? humanise(req.level) : "—"}</Fact>
              <Fact label="Function">{req.jobFunction ? humanise(req.jobFunction) : "—"}</Fact>
              <Fact label="Openings">{req.numberOfOpenings}</Fact>
              <Fact label="Opened">{fmtDate(req.postedAt)}</Fact>
              <Fact label="Target start">{fmtDate(req.targetStartDate)}</Fact>
              <Fact label="Assigned to you">{fmtDate(req.assignedAt)}</Fact>
            </dl>
          </Card>
        </div>

        {/* Commercials the partner is allowed to see */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Compensation band
          </h2>
          <Card>
            <p className="text-lg font-semibold tabular-nums text-neutral-900">
              {fmtCompBand(req.compBandMin, req.compBandMax, req.compCurrency)}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              {req.compBandMin === null && req.compBandMax === null
                ? "Kyndryl hasn't published a band for this role. Ask your Kyndryl point of contact before setting candidate expectations."
                : "Annual base band for this position. Final offers depend on the candidate's assessment outcome."}
            </p>
          </Card>
        </section>

        {/* The JD locked onto the requisition */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Job description
          </h2>
          <Card className="flex flex-col gap-4">
            {req.jdSummary ? (
              <p className="border-l-2 border-brand-200 pl-3 text-sm leading-relaxed text-neutral-700">
                {req.jdSummary}
              </p>
            ) : null}
            {/* Plain text, not markdown — the partner portal has no renderer
                and adding a dependency to display a JD isn't worth it. */}
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-800">
              {req.jdText}
            </div>
          </Card>
        </section>

        {/* Knockouts — what will disqualify a candidate before anyone reads the CV */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight text-neutral-900">
              Screening questions
            </h2>
            <span className="text-sm text-neutral-500">
              {req.knockouts.length}{" "}
              {req.knockouts.length === 1 ? "knockout question" : "knockout questions"}
            </span>
          </div>
          {req.knockouts.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                title="No screening questions on this role"
                hint="Candidates you submit go straight to CV review."
              />
            </Card>
          ) : (
            <Card padded={false}>
              <ol className="divide-y divide-neutral-100">
                {[...req.knockouts]
                  .sort((a, b) => a.orderIndex - b.orderIndex)
                  .map((k, i) => (
                    <li key={k.id} className="flex gap-3 px-4 py-3">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-medium tabular-nums text-neutral-600">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm text-neutral-900">{k.questionText}</p>
                        {k.requirement ? (
                          <p className="mt-1 text-sm text-neutral-500">
                            Required: <span className="text-neutral-700">{k.requirement}</span>
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
              </ol>
              <p className="border-t border-neutral-100 px-4 py-3 text-sm text-neutral-500">
                Answers are collected when you submit a candidate. Screen against these first — a
                candidate who fails any of them is rejected automatically.
              </p>
            </Card>
          )}
        </section>

        {/* The point of the page */}
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-900">Have someone for this role?</p>
            <p className="mt-0.5 text-sm text-neutral-500">
              {req.yourSubmissionCount === 0
                ? "Your organisation hasn't submitted anyone to this req yet."
                : req.yourSubmissionCount === 1
                  ? "Your organisation has submitted 1 candidate to this req."
                  : `Your organisation has submitted ${req.yourSubmissionCount} candidates to this req.`}
            </p>
          </div>
          <a
            href={submitHref}
            className="inline-flex shrink-0 items-center rounded-button bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            Submit candidate
          </a>
        </Card>
      </div>
    </PartnerShell>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-0.5 truncate text-sm capitalize text-neutral-900">{children}</dd>
    </div>
  );
}
