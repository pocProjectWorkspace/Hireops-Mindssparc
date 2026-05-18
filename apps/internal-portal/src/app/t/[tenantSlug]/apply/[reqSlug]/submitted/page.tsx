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
import { Card } from "@hireops/ui";
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
    if (
      err instanceof TRPCError &&
      (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")
    ) {
      notFound();
    }
    throw err;
  }

  const ref = (searchParams.ref ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-10 sm:px-6">
      <Card className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold text-neutral-900">Application received</h1>
        <p className="text-base text-neutral-700">
          Thanks for applying to <strong>{resolved.positionTitle}</strong> at{" "}
          <strong>{resolved.tenantDisplayName}</strong>. We&rsquo;ll be in touch within the next
          few business days if there&rsquo;s a fit.
        </p>
        {ref && (
          <p className="text-sm text-neutral-600">
            Your reference: <strong className="font-mono">{ref}</strong>
          </p>
        )}
        <p className="text-sm text-neutral-600">
          A confirmation email is on its way. You don&rsquo;t need to do anything right now.
        </p>
      </Card>
      <p className="text-center text-xs text-neutral-500">
        <Link href="/privacy" className="text-brand-600 underline">
          Privacy policy
        </Link>
      </p>
    </main>
  );
}
