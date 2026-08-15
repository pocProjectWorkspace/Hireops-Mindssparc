import { TRPCError } from "@trpc/server";
import type { PartnerFeeRow } from "@hireops/api-types";
import { requireAuth } from "@/lib/auth";
import { createPartnerServerTRPCCaller } from "@/lib/trpc-server";
import { PartnerShell } from "@/components/PartnerShell";
import { NotAPartner } from "@/components/dashboard/NotAPartner";
import { fmtDate } from "@/components/reqs/req-format";
import { Badge, Card, EmptyState, StatTile } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

// Session-dependent reads — never prerender.
export const dynamic = "force-dynamic";

function roleLabel(role: "partner_admin" | "partner_user"): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * /commercials — the partner org admin's fee ledger (P2.2, partner-wireflows
 * §3.11): what has accrued on their placements, what is payable, what has been
 * paid, and the terms each fee was computed under.
 *
 * Two guards, in the same order /team uses. partnerGetMe FORBIDDEN means the
 * signed-in identity isn't a partner at all → the honest NotAPartner state. A
 * partner who simply isn't their org's admin gets a CALM in-shell notice: they
 * are legitimately here, this page just isn't theirs. Neither guard is the real
 * gate — partnerGetCommercials enforces partner_admin server-side, so a
 * hand-typed /commercials leaks nothing.
 *
 * What is deliberately NOT on this page: the MSA itself. The terms document is
 * an internal-staff artefact (partner_msa has no partner-facing read at all);
 * what a partner sees is the terms FROZEN onto each fee row, which is the part
 * that actually explains the number next to it. Showing today's agreement above
 * rows accrued under an older one would invite exactly the wrong arithmetic.
 */

/** Minor units + ISO currency → a readable amount; unknown codes degrade. */
function fmtFee(amountMinor: number, currency: string): string {
  const code = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  if (code) {
    try {
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
      }).format(amountMinor / 100);
    } catch {
      // Unknown ISO code — fall through to the plain rendering below.
    }
  }
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(
    amountMinor / 100,
  )} ${currency}`;
}

/** The fee lifecycle in the partner's own words, with its badge tone. */
const FEE_STATUS: Record<PartnerFeeRow["status"], { label: string; tone: BadgeTone }> = {
  accrued: { label: "In guarantee period", tone: "warning" },
  payable: { label: "Payable", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  disputed: { label: "Under query", tone: "error" },
};

/** The terms a row was computed under, from its frozen snapshot. */
function termsLabel(fee: PartnerFeeRow): string {
  if (fee.feeModel === "percentage_ctc") return `${fee.feePercent ?? 0}% of annual base`;
  if (fee.feeModel === "flat_per_hire") return "Flat fee per hire";
  return "As agreed";
}

export default async function CommercialsPage() {
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
    active: "commercials" as const,
    isOrgAdmin: me.role === "partner_admin",
  };

  if (me.role !== "partner_admin") {
    return (
      <PartnerShell {...shellProps}>
        <div className="flex flex-col gap-6">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Commercials</h1>
          <Card className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-neutral-900">
              Fees are for your organisation&rsquo;s admin
            </h2>
            <p className="text-sm text-neutral-500">
              Ask the admin at {me.orgName} if you need to see what has been invoiced or paid.
              Everything else in the portal is open to you as usual.
            </p>
            <div className="pt-1">
              <a
                href="/"
                className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
              >
                Back to dashboard
              </a>
            </div>
          </Card>
        </div>
      </PartnerShell>
    );
  }

  const { fees, rollups } = await caller.partnerGetCommercials();

  return (
    <PartnerShell {...shellProps}>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Commercials</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Every fee {me.orgName} has earned on a placement, with the terms it was calculated
            under. Amounts move from the guarantee period to payable once the replacement guarantee
            has run.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatTile
            label="Accrued"
            value={fmtFee(rollups.accruedMinor, rollups.currency)}
            hint="Still inside the guarantee period"
          />
          <StatTile
            label="Payable"
            value={fmtFee(rollups.payableMinor, rollups.currency)}
            hint="Guarantee served, awaiting payment"
          />
          <StatTile
            label="Paid"
            value={fmtFee(rollups.paidMinor, rollups.currency)}
            hint="Settled"
          />
        </div>

        {fees.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No fees accrued yet"
              hint="Fees appear here when a candidate your team submitted is hired. Nothing is calculated before that point."
              action={
                <a
                  href="/submissions"
                  className="inline-flex items-center rounded-button bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                >
                  See your submissions
                </a>
              }
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {fees.map((fee) => (
                <li
                  key={fee.feeId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {fee.candidateName ?? "Candidate"}
                    </p>
                    <p className="truncate text-sm text-neutral-500">
                      {fee.requisitionTitle ?? "Role no longer listed"} · hired{" "}
                      {fmtDate(fee.hiredAt)} · {termsLabel(fee)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-3">
                    <span className="text-sm font-medium tabular-nums text-neutral-900">
                      {fmtFee(fee.feeMinor, fee.feeCurrency)}
                    </span>
                    <Badge tone={FEE_STATUS[fee.status].tone}>{FEE_STATUS[fee.status].label}</Badge>
                    <span className="text-sm text-neutral-500">
                      {fee.status === "accrued" && fee.holdbackReleaseAt
                        ? `Payable from ${fmtDate(fee.holdbackReleaseAt)}`
                        : fee.holdbackReleaseAt
                          ? `Guarantee ended ${fmtDate(fee.holdbackReleaseAt)}`
                          : "No guarantee period"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <p className="text-sm text-neutral-500">
          These figures are the platform&rsquo;s record of what your placements have earned; they
          are not an invoice. Anything that looks wrong is worth raising with your Kyndryl point of
          contact — the terms shown against each fee are the ones it was computed from.
        </p>
      </div>
    </PartnerShell>
  );
}
