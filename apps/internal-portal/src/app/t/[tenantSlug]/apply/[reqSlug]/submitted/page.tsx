/**
 * Confirmation page rendered after successful submitApplication (CRS-01).
 *
 * Re-resolves the tenant + requisition via the public procedure so the
 * page survives a direct paste of the URL into a new tab (the ref is
 * just a display value; the slugs are the source of truth).
 *
 * The reference comes in as `?ref=<8 chars>` — the prefix of the
 * application UUID. Candidates use it as a quoting handle when they
 * email back; we don't persist it as a separate column.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { Card } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { createPublicServerTRPCCaller } from "@/lib/trpc-server";

export default async function PublicApplySubmittedPage({
  params,
  searchParams,
}: {
  params: { tenantSlug: string; reqSlug: string };
  searchParams: { ref?: string };
}) {
  const caller = createPublicServerTRPCCaller();
  let resolved;
  try {
    resolved = await caller.resolvePublicRequisition({
      tenantSlug: params.tenantSlug,
      reqSlug: params.reqSlug,
    });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
      notFound();
    }
    throw err;
  }

  const ref = (searchParams.ref ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);

  return (
    <CandidateShell
      brand={resolved.tenantDisplayName}
      footer={
        <p className="text-xs text-neutral-500">
          <Link href="/privacy" className="text-brand-600 underline">
            Privacy policy
          </Link>
        </p>
      }
    >
      <Card className="flex flex-col items-center gap-4 p-6 text-center sm:p-8">
        <span
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-status-positive-50 text-status-positive-600"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>

        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Application received
          </h1>
          <p className="text-sm text-neutral-600">
            Thanks for applying to{" "}
            <strong className="text-neutral-800">{resolved.positionTitle}</strong> at{" "}
            <strong className="text-neutral-800">{resolved.tenantDisplayName}</strong>.
          </p>
        </div>

        {ref && (
          <div className="flex flex-col items-center gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Your reference
            </p>
            <p className="select-all rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 font-mono text-base tracking-wider text-neutral-900">
              {ref}
            </p>
          </div>
        )}

        <div className="mt-1 w-full border-t border-neutral-100 pt-4 text-sm text-neutral-600">
          <p className="mb-1 font-medium text-neutral-800">What happens next</p>
          <p>
            A confirmation email is on its way. We&rsquo;ll be in touch within the next few business
            days if there&rsquo;s a fit — you don&rsquo;t need to do anything right now.
          </p>
        </div>
      </Card>
    </CandidateShell>
  );
}
