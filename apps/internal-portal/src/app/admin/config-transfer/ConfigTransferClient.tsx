"use client";

import { useState } from "react";
import type { PreviewTenantConfigImportOutput } from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";

/**
 * C1-F11 — export the tenant's configuration as JSON; import one with a
 * dry-run diff (adds / changes / removals per section) before applying.
 * A section present in the file replaces that section; an absent section is
 * left alone. Removals deactivate / archive / reset — nothing is hard-deleted.
 */
export function ConfigTransferClient() {
  const utils = trpc.useUtils();
  const [message, setMessage] = useState<string | null>(null);
  const [doc, setDoc] = useState<unknown>(null);
  const [preview, setPreview] = useState<PreviewTenantConfigImportOutput | null>(null);
  const previewM = trpc.previewTenantConfigImport.useMutation({
    onSuccess: (p) => setPreview(p),
    onError: (e) => setMessage(e.message),
  });
  const applyM = trpc.applyTenantConfigImport.useMutation({
    onSuccess: (r) => {
      setMessage(
        `Imported ${r.applied.length} section(s).${r.skipped.length ? ` Not applied: ${r.skipped.join("; ")}` : ""}`,
      );
      setPreview(null);
      setDoc(null);
    },
    onError: (e) => setMessage(e.message),
  });

  async function exportNow() {
    try {
      const out = await utils.exportTenantConfig.fetch({});
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
    }
  }

  async function onFile(file: File | undefined) {
    setPreview(null);
    setMessage(null);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      setDoc(parsed);
      previewM.mutate({ document: parsed });
    } catch {
      setMessage("That file is not valid JSON.");
    }
  }

  return (
    <PageContainer variant="measure">
      <PageHeader
        title="Configuration export / import"
        subtitle="Move this organisation's setup between environments or clone it for a similar team. People, candidates, requisitions and credentials are never included."
      />
      <div className="mt-6 flex flex-col gap-6">
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Export</h2>
          <Button size="sm" onClick={() => void exportNow()}>
            Download configuration (JSON)
          </Button>
        </Card>
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Import</h2>
          <p className="mb-3 text-sm text-neutral-600">
            Choose a file to see what would change. Nothing is saved until you apply.
          </p>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {preview && !preview.ok ? (
            <p role="alert" className="mt-3 text-sm text-status-error-700">
              {preview.error}
            </p>
          ) : null}
          {preview && preview.ok ? (
            <div className="mt-4">
              {preview.empty ? (
                <p className="text-sm text-neutral-600">
                  No changes — this organisation already matches the file.
                </p>
              ) : (
                <ul className="divide-y divide-neutral-100 text-sm">
                  {preview.diff
                    .filter(
                      (d) =>
                        d.adds.length + d.changes.length + d.removals.length + d.warnings.length >
                        0,
                    )
                    .map((d) => (
                      <li key={d.section} className="py-2">
                        <span className="font-medium">{d.label}</span>
                        <span className="ml-2 text-neutral-600">
                          {d.adds.length} add · {d.changes.length} change · {d.removals.length}{" "}
                          remove
                        </span>
                        {[
                          ...d.adds.map((k) => `+ ${k}`),
                          ...d.changes.map((k) => `~ ${k}`),
                          ...d.removals.map((k) => `− ${k}`),
                        ].length > 0 ? (
                          <p className="mt-1 text-xs text-neutral-500">
                            {[
                              ...d.adds.map((k) => `+ ${k}`),
                              ...d.changes.map((k) => `~ ${k}`),
                              ...d.removals.map((k) => `− ${k}`),
                            ].join(", ")}
                          </p>
                        ) : null}
                        {d.warnings.map((w) => (
                          <p key={w} className="mt-1 text-xs text-status-warning-800">
                            {w}
                          </p>
                        ))}
                      </li>
                    ))}
                </ul>
              )}
              {!preview.empty && preview.fingerprint ? (
                <Button
                  size="sm"
                  className="mt-3"
                  disabled={applyM.isPending}
                  onClick={() =>
                    applyM.mutate({ document: doc, fingerprint: preview.fingerprint as string })
                  }
                >
                  Apply import
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
        {message ? (
          <p role="status" className="text-sm text-neutral-700">
            {message}
          </p>
        ) : null}
      </div>
    </PageContainer>
  );
}
