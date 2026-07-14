/**
 * Public candidate apply page (CRS-01).
 *
 * Mounted at /t/[tenantSlug]/apply/[reqSlug]. Middleware allowlist
 * (PUBLIC_PREFIXES) lets it through without a Supabase session.
 *
 * Server component does the slug → requisition resolution via the
 * publicProcedure `resolvePublicRequisition` and 404s on any of:
 * tenant missing, requisition missing, requisition not in a
 * publishable state. The form itself is a client component so the
 * resume upload + tRPC mutation can run from the browser.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { Badge, Card } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { createPublicServerTRPCCaller } from "@/lib/trpc-server";
import { ApplyForm } from "./ApplyForm";

export default async function PublicApplyPage({
  params,
}: {
  params: { tenantSlug: string; reqSlug: string };
}) {
  const caller = createPublicServerTRPCCaller();
  let resolved;
  try {
    resolved = await caller.resolvePublicRequisition({
      tenantSlug: params.tenantSlug,
      reqSlug: params.reqSlug,
    });
  } catch (err) {
    // BAD_REQUEST = the URL slugs failed regex / length validation in
    // zod. From the candidate's perspective a malformed slug is
    // indistinguishable from a missing one — 404 in both cases.
    if (err instanceof TRPCError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
      notFound();
    }
    throw err;
  }

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
      <header className="flex flex-col gap-2">
        <Badge tone="accent" className="w-fit">
          Now hiring
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          {resolved.positionTitle}
        </h1>
        <p className="text-sm text-neutral-600">
          Apply below. The {resolved.tenantDisplayName} recruiting team will reach out within the
          next few business days if there&rsquo;s a fit.
        </p>
      </header>

      <Card className="p-5 sm:p-6">
        <ApplyForm
          requisitionId={resolved.requisitionId}
          tenantDisplayName={resolved.tenantDisplayName}
          positionTitle={resolved.positionTitle}
          tenantSlug={params.tenantSlug}
          reqSlug={params.reqSlug}
        />
      </Card>
    </CandidateShell>
  );
}
