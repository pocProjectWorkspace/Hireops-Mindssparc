import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { requirePlatformOperator } from "@/lib/auth";
import { createPlatformServerTRPCCaller } from "@/lib/trpc-server";
import { PlatformShell, TenantStatusBadge } from "@/components/platform/PlatformShell";
import { Card } from "@/components/ui";
import { TenantControls } from "./TenantControls";
import { ProvisioningPanel } from "./ProvisioningPanel";

export const dynamic = "force-dynamic";

/**
 * C1-F10 — one tenant in the platform console: metadata + counts, lifecycle
 * status change (reason required, audited) and module entitlements. The
 * controls are a client island; writes go through platformWriteProcedure.
 */
export default async function PlatformTenantPage({ params }: { params: { tenantId: string } }) {
  const op = await requirePlatformOperator();
  const caller = createPlatformServerTRPCCaller(op.userId);
  const me = await caller.platformWhoami();
  let data;
  let provisioning;
  try {
    data = await caller.platformGetTenant({ tenantId: params.tenantId });
    provisioning = (await caller.platformGetProvisioningStatus({ tenantId: params.tenantId }))
      .status;
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "NOT_FOUND" || err.code === "BAD_REQUEST")) {
      notFound();
    }
    throw err;
  }
  const t = data.tenant;
  const facts: [string, string | number][] = [
    ["Slug", t.slug],
    ["Tier", t.tier],
    ["Region", t.primaryRegion],
    ["Onboarding", t.onboardingStatus],
    ["Created", t.createdAt.slice(0, 10)],
    ["Activated", t.activatedAt?.slice(0, 10) ?? "—"],
    ["Suspended", t.suspendedAt?.slice(0, 10) ?? "—"],
    ["Active members", t.activeMembers],
    ["Active requisitions", t.activeRequisitions],
    ["Partner users", t.partnerUsers],
    ["Candidate accounts", t.candidateAccounts],
  ];

  return (
    <PlatformShell title={t.displayName} active="tenants" operator={me}>
      <div className="mb-4 flex items-center gap-3">
        <a href="/platform" className="text-sm text-brand-700 hover:underline">
          ← All tenants
        </a>
        <TenantStatusBadge status={t.status} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Registry</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-neutral-500">{k}</dt>
                <dd className="text-neutral-900">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <TenantControls
          tenantId={t.id}
          status={t.status}
          modules={data.modules}
          canWrite={me.canWrite}
        />
      </div>
      <ProvisioningPanel tenantId={t.id} status={provisioning} canWrite={me.canWrite} />
      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">Platform audit (latest 20)</h2>
        {data.recentAudit.length === 0 ? (
          <p className="text-sm text-neutral-500">No platform changes recorded for this tenant.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 text-sm">
            {data.recentAudit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 py-2">
                <span className="text-neutral-500">
                  {a.createdAt.replace("T", " ").slice(0, 16)}
                </span>
                <span className="font-medium">{a.action}</span>
                <span className="text-neutral-600">{a.operatorEmail}</span>
                <code className="text-xs text-neutral-500">{JSON.stringify(a.summary)}</code>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PlatformShell>
  );
}
