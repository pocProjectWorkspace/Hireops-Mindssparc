import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { fmtDate } from "@/components/reqs/req-format";
import { StageFilter } from "@/components/submissions/StageFilter";
import { isPartnerStage, stageLabel, stageTone } from "@/components/submissions/submission-format";
import { Badge, Card, EmptyState } from "@/components/ui";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * /submissions — every candidate the partner's org has submitted (P1.2,
 * partner-wireflows §3.7). Stage visibility is stage + date ONLY: no internal
 * feedback, no reasons, no scores, no Kyndryl actor names (requirements.md
 * §6.3). The API enforces that; this surface simply has nothing else to show.
 *
 * The stage filter is a real server-side query (`?stage=` → the API's `stage`
 * input), so the cap note below stays honest — it reports rows behind the cap
 * for the query that actually ran, not for a client-side subset.
 */
export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams?: { stage?: string | string[] };
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

  // A hand-edited ?stage= that isn't a real stage is dropped rather than sent
  // to the API, where zod would reject it as a hard error.
  const rawStage = Array.isArray(searchParams?.stage)
    ? searchParams?.stage[0]
    : searchParams?.stage;
  const stage = isPartnerStage(rawStage) ? rawStage : null;

  const submissions = await caller.partnerListMySubmissions(stage ? { stage } : undefined);

  return (
    <PartnerShell
      orgName={me.orgName}
      user={{ label: me.displayName, role: roleLabel(me.role) }}
      active="submissions"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
              Your submissions
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Every candidate {me.orgName} has submitted, with the stage they have reached. Open one
              for its timeline and your ownership window.
            </p>
          </div>
          <StageFilter value={stage} />
        </div>

        {submissions.items.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title={
                stage
                  ? `No submissions at ${stageLabel(stage).toLowerCase()}`
                  : "No submissions yet"
              }
              hint={
                stage
                  ? "Nothing sits at that stage right now. Choose All stages to see everyone you have submitted."
                  : "Candidates your team submits will track here with their live stage. Start from a requisition that's open to you."
              }
              action={
                stage ? (
                  <a
                    href="/submissions"
                    className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                  >
                    Show all stages
                  </a>
                ) : (
                  <a
                    href="/reqs"
                    className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                  >
                    Browse your reqs
                  </a>
                )
              }
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {submissions.items.map((s) => (
                <li key={s.claimId}>
                  <a
                    href={`/submissions/${s.claimId}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-900">
                        {s.candidateName ?? "Candidate"}
                      </p>
                      <p className="truncate text-sm text-neutral-500">
                        {s.requisitionTitle ?? "Speculative submission"} · submitted{" "}
                        {fmtDate(s.claimedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {s.stage ? (
                        <Badge tone={stageTone(s.stage)}>{stageLabel(s.stage)}</Badge>
                      ) : (
                        <Badge tone="neutral">No application yet</Badge>
                      )}
                      <span className="text-sm text-neutral-500">
                        {s.status === "active"
                          ? `Owned until ${fmtDate(s.expiresAt)}`
                          : `Ownership ${s.status}`}
                      </span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {submissions.capped ? (
          <p className="text-sm text-neutral-500">
            Showing the most recent {submissions.items.length} submissions — filter by stage to see
            older ones.
          </p>
        ) : null}
      </div>
    </PartnerShell>
  );
}
