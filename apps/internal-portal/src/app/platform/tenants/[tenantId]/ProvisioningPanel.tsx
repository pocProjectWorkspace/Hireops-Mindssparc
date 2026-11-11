"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProvisioningStatus } from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * C1-F11 — provisioning progress for a console-created tenant: each step with
 * its state, the last error, Retry (resumes at the failed step; never repeats
 * a finished one), and a configuration export download (no people data, no
 * secrets). Write actions are refused server-side for `support`.
 */
export function ProvisioningPanel({
  tenantId,
  status,
  canWrite,
}: {
  tenantId: string;
  status: ProvisioningStatus | null;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const retry = trpc.platformRetryProvisioning.useMutation({
    onSuccess: (r) => {
      setMessage(
        r.jobStatus === "completed" ? "Provisioning completed." : `Provisioning ${r.jobStatus}.`,
      );
      router.refresh();
    },
    onError: (e) => setMessage(e.message),
  });
  const [exporting, setExporting] = useState(false);

  async function downloadExport() {
    setExporting(true);
    try {
      const out = await utils.platformExportTenantConfig.fetch({ tenantId });
      const blob = new Blob([JSON.stringify(out.document, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${out.document.source?.tenantSlug ?? "tenant"}-config.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMessage(
        out.skipped.length ? `Exported. Not included: ${out.skipped.join("; ")}` : "Exported.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Provisioning</h2>
        {canWrite ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={exporting}
            onClick={() => void downloadExport()}
          >
            Export configuration
          </Button>
        ) : null}
      </div>
      {!status ? (
        <p className="text-sm text-neutral-500">
          This tenant was created before platform provisioning (by a seed script); there is no
          provisioning record.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-neutral-700">
            Starter pack <span className="font-medium">{status.starterPack.key}</span> v
            {status.starterPack.version} · first admin {status.adminEmail} · job{" "}
            <span className="font-medium">{status.jobStatus}</span> · attempts {status.attempts}
          </p>
          <ol className="mb-3 divide-y divide-neutral-100 text-sm">
            {status.steps.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>{s.label}</span>
                <span
                  className={
                    s.status === "done"
                      ? "text-status-positive-700"
                      : s.status === "failed"
                        ? "text-status-error-700"
                        : "text-neutral-400"
                  }
                >
                  {s.status}
                  {s.completedAt ? ` · ${s.completedAt.replace("T", " ").slice(0, 16)}` : ""}
                </span>
              </li>
            ))}
          </ol>
          {status.lastError ? (
            <p role="alert" className="mb-3 text-sm text-status-error-700">
              {status.lastError}
            </p>
          ) : null}
          {canWrite && status.jobStatus !== "completed" ? (
            <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate({ tenantId })}>
              {retry.isPending ? "Retrying…" : "Retry provisioning"}
            </Button>
          ) : null}
        </>
      )}
      {message ? (
        <p role="status" className="mt-3 text-sm text-neutral-700">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
