import type { ReactNode } from "react";
import { TRPCError } from "@trpc/server";
import type { PartnerGetSubmissionDetailOutput } from "@hireops/api-types";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { fmtDate } from "@/components/reqs/req-format";
import {
  SNAPSHOT_FIELDS,
  ownershipState,
  snapshotValue,
  stageLabel,
  stageTone,
} from "@/components/submissions/submission-format";
import { Badge, Card, EmptyState } from "@/components/ui";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * /submissions/<claimId> — one candidate as the partner who submitted them is
 * allowed to see them (P1.2, partner-wireflows §3.8): the ownership lock and
 * its expiry, the live stage, the stage-only timeline, and the immutable
 * snapshot of what they sent.
 *
 * Everything absent here is absent on purpose (requirements.md §6.3): no AI
 * score, no interview feedback, no rejection reason, no Kyndryl actor names.
 * The API doesn't return them, so there is nothing on this page to leak.
 *
 * Authorization is entirely the API's: another org's claim, another tenant's
 * claim, and a claimId that doesn't exist all raise the SAME FORBIDDEN, so
 * this page renders one calm notice for all three rather than distinguishing
 * them — distinguishing them would leak exactly what the API refuses to. A
 * malformed id (zod BAD_REQUEST) gets the same treatment: it is, by
 * definition, not one of your submissions.
 */
export default async function SubmissionDetailPage({ params }: { params: { claimId: string } }) {
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
    active: "submissions" as const,
    canManageTeam: me.role === "partner_admin",
  };

  let detail: PartnerGetSubmissionDetailOutput;
  try {
    detail = await caller.partnerGetSubmissionDetail({ claimId: params.claimId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "BAD_REQUEST")) {
      return (
        <PartnerShell {...shellProps}>
          <Card padded={false}>
            <EmptyState
              title="This submission isn't one of yours."
              hint="It may belong to another organisation, or the link may be out of date. Everyone your team has submitted is listed on the Submissions page."
              action={
                <a
                  href="/submissions"
                  className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                >
                  Back to your submissions
                </a>
              }
            />
          </Card>
        </PartnerShell>
      );
    }
    throw err;
  }

  const ownership = ownershipState(detail.claim);
  const snapshotRows = SNAPSHOT_FIELDS.map((f) => ({
    label: f.label,
    value: snapshotValue(detail.submittedSnapshot, f.key),
  })).filter((r) => r.value !== null);

  return (
    <PartnerShell {...shellProps}>
      <div className="flex flex-col gap-6">
        <a
          href="/submissions"
          className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline"
        >
          ← All submissions
        </a>

        {/* Header — who, for what, and where they've got to */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
              {detail.candidate.fullName ?? "Candidate"}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Submitted by {me.orgName} on {fmtDate(detail.claim.claimedAt)}
              {detail.requisition ? (
                <>
                  {" · "}
                  <a
                    href={`/reqs/${detail.requisition.requisitionId}`}
                    className="text-brand-700 hover:underline"
                  >
                    {detail.requisition.title}
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <Badge tone={stageTone(detail.application?.currentStage ?? null)}>
            {detail.application
              ? stageLabel(detail.application.currentStage)
              : "No application yet"}
          </Badge>
        </div>

        {/* Ownership banner — the lock, and the honest lapsed states */}
        <Card
          className={
            ownership.active
              ? "border-status-positive-200 bg-status-positive-50"
              : "border-status-warning-200 bg-status-warning-50"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ownership.tone}>{ownership.active ? "Owned" : "Lapsed"}</Badge>
            <p className="text-sm font-medium text-neutral-900">{ownership.headline}</p>
          </div>
          <p className="mt-1.5 text-sm text-neutral-700">{ownership.detail}</p>
        </Card>

        {/* Timeline — stage + date, and nothing else (requirements.md §6.3) */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">Timeline</h2>
          {detail.timeline.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                title="Nothing has moved yet"
                hint="Stage changes appear here as the Kyndryl team progresses this candidate."
              />
            </Card>
          ) : (
            <Card padded={false}>
              <ol className="divide-y divide-neutral-100">
                {detail.timeline.map((entry, i) => (
                  <li
                    key={`${entry.transitionedAt}-${entry.toStage}-${i}`}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        i === detail.timeline.length - 1 ? "bg-brand-500" : "bg-neutral-300"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
                      {stageLabel(entry.toStage)}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-neutral-500">
                      {fmtDate(entry.transitionedAt)}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="border-t border-neutral-100 px-4 py-3 text-sm text-neutral-500">
                Stage and date only. Interview feedback and assessment notes stay internal to
                Kyndryl — contact your Kyndryl point of contact if you need a debrief.
              </p>
            </Card>
          )}
        </section>

        {/* What the partner submitted — read-only by definition */}
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Submitted details
          </h2>
          <Card>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="Full name">{detail.candidate.fullName ?? "—"}</Fact>
              <Fact label="Email">{detail.candidate.email ?? "—"}</Fact>
              <Fact label="Phone">{detail.candidate.phone ?? "—"}</Fact>
              <Fact label="Submitted">{fmtDate(detail.claim.claimedAt)}</Fact>
              {snapshotRows.map((r) => (
                <Fact key={r.label} label={r.label}>
                  {r.value}
                </Fact>
              ))}
            </dl>
            <p className="mt-4 border-t border-neutral-100 pt-3 text-sm text-neutral-500">
              This is the submission as you sent it — it can&apos;t be edited after the fact.
              Documents (CV, consent record): available on request from your Kyndryl point of
              contact.
              {/* Deferred from P1.2 on purpose: downloading the stored CV /
                  consent record needs signed-URL support the partner tier
                  doesn't have yet (the internal portal proxies its downloads
                  through an authenticated route). Promising a download button
                  we can't honour would be worse than this line. */}
            </p>
          </Card>
        </section>
      </div>
    </PartnerShell>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-neutral-900">{children}</dd>
    </div>
  );
}
