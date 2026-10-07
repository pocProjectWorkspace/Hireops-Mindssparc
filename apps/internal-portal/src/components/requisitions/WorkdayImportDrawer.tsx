"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ImportWorkdayRequisitionsOutput, WorkdayMappingStatus } from "@hireops/api-types";
import { Badge, Button, Card, TableShell, Tbody, Td, Th, Thead, Tr } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * "Import from Workday" — PoC PREVIEW drawer (requisitions list header).
 *
 * HONESTY: there is NO live Workday connection. Step 1 explains the three PoC
 * connection options; step 2 previews a BUILT-IN sample Workday requisition
 * export with a field mapping validated server-side against this tenant's real
 * business units / members / comp bands; step 3 creates real DRAFT
 * requisitions through the same path as the wizard. Copy never claims the
 * connection exists.
 */

type Step = 1 | 2 | 3;

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: "How it connects" },
  { n: 2, label: "Preview the Workday export" },
  { n: 3, label: "Import as drafts" },
];

const OPTIONS = [
  {
    title: "Workday report pull",
    body: "A read-only Workday custom report (RaaS) or API that HireOps reads on a schedule. Best long-term option; needs Solenis's Workday team to grant access.",
  },
  {
    title: "SFTP file drop",
    body: "Workday sends a scheduled requisition export to a secure folder; HireOps picks the file up.",
  },
  {
    title: "RPA bot → SharePoint",
    body: "A bot exports open requisitions from Workday into a SharePoint library; HireOps reads the file from there.",
  },
];

const STATUS_META: Record<WorkdayMappingStatus, { tone: BadgeTone; label: string }> = {
  mapped: { tone: "success", label: "✓ Mapped" },
  needs_review: { tone: "warning", label: "⚠ Needs review" },
  not_imported: { tone: "neutral", label: "Not imported" },
};

function PreviewBanner() {
  return (
    <div className="rounded-card border border-status-warning-200 bg-status-warning-50 px-4 py-2 text-xs font-medium text-status-warning-800">
      PoC preview — no live Workday connection. Data below is a sample Workday export.
    </div>
  );
}

export function WorkdayImportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Import from Workday
      </Button>
      {open ? <WorkdayImportDrawer onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function WorkdayImportDrawer({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<Step>(1);
  const [selected, setSelected] = useState(0);
  const [result, setResult] = useState<ImportWorkdayRequisitionsOutput | null>(null);

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [close]);

  const preview = trpc.previewWorkdayRequisitionImport.useQuery();
  const importMut = trpc.importWorkdayRequisitions.useMutation({
    onSuccess: async (data) => {
      setResult(data);
      await Promise.all([
        utils.previewWorkdayRequisitionImport.invalidate(),
        utils.listMyRequisitionsV2.invalidate(),
      ]);
      router.refresh();
    },
  });

  const rows = preview.data?.rows ?? [];
  const columns = preview.data?.columns ?? [];
  const pending = rows.filter((r) => !r.alreadyImported);
  const current = rows[selected];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import from Workday (PoC preview)"
      className="fixed inset-0 z-modal flex justify-end"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={close}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[64rem] max-w-[96vw] flex-col overflow-hidden bg-neutral-50 shadow-3">
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-6 py-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900">
              Import from Workday
              <Badge tone="warning">PoC preview</Badge>
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              No live Workday connection — this preview uses a sample Workday requisition export.
            </p>
            <ol className="mt-3 flex flex-wrap gap-2 text-xs">
              {STEPS.map((s) => (
                <li key={s.n}>
                  <button
                    type="button"
                    onClick={() => setStep(s.n)}
                    className={
                      s.n === step
                        ? "rounded-full bg-brand-600 px-3 py-1 font-medium text-white"
                        : "rounded-full bg-neutral-100 px-3 py-1 text-neutral-600 hover:bg-neutral-200"
                    }
                  >
                    {s.n}. {s.label}
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            onClick={close}
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <PreviewBanner />

          {step === 1 ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-neutral-900">
                How it connects (PoC options)
              </h3>
              <div className="grid gap-3 md:grid-cols-3">
                {OPTIONS.map((o, i) => (
                  <Card key={o.title}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                      Option {i + 1}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-neutral-900">{o.title}</p>
                    <p className="mt-2 text-sm text-neutral-600">{o.body}</p>
                  </Card>
                ))}
              </div>
              <p className="text-sm text-neutral-600">
                Options 2 and 3 deliver a file — the same SharePoint intake HireOps uses for CVs.
                For this preview we use a sample Workday requisition export.
              </p>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">
                  Sample Workday export ({rows.length} requisitions)
                </h3>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Standard Workday requisition report fields, exactly as the export delivers them.
                </p>
              </div>
              {preview.isLoading ? (
                <p className="text-sm text-neutral-500">Loading preview…</p>
              ) : preview.error ? (
                <p className="text-sm text-status-error-700">
                  Couldn&apos;t load the preview: {preview.error.message}
                </p>
              ) : (
                <>
                  <TableShell>
                    <Thead>
                      {columns.map((c) => (
                        <Th key={c} className="whitespace-nowrap">
                          {c}
                        </Th>
                      ))}
                    </Thead>
                    <Tbody>
                      {rows.map((r) => (
                        <Tr key={r.jobRequisitionId}>
                          {columns.map((c) => (
                            <Td key={c} label={c} className="whitespace-nowrap">
                              {r.fields[c] ?? "—"}
                            </Td>
                          ))}
                        </Tr>
                      ))}
                    </Tbody>
                  </TableShell>

                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-900">Field mapping</h3>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Checked just now against this workspace&apos;s business units, people and
                        comp bands.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {rows.map((r, i) => (
                        <button
                          key={r.jobRequisitionId}
                          type="button"
                          onClick={() => setSelected(i)}
                          className={
                            i === selected
                              ? "rounded-button border border-brand-600 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700"
                              : "rounded-button border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
                          }
                        >
                          {r.jobRequisitionId} · {r.fields["Job Posting Title"]}
                          {r.needsReviewCount > 0 ? ` · ⚠ ${r.needsReviewCount}` : " · ✓"}
                        </button>
                      ))}
                    </div>
                    {current ? (
                      <TableShell>
                        <Thead>
                          <Th>Workday field</Th>
                          <Th>Workday value</Th>
                          <Th>HireOps field</Th>
                          <Th>HireOps value</Th>
                          <Th>Status</Th>
                        </Thead>
                        <Tbody>
                          {current.mapping.map((m) => (
                            <Tr key={m.workdayField}>
                              <Td label="Workday field" className="font-medium text-neutral-900">
                                {m.workdayField}
                              </Td>
                              <Td label="Workday value">{m.workdayValue}</Td>
                              <Td label="HireOps field">{m.hireopsField}</Td>
                              <Td label="HireOps value">{m.hireopsValue ?? "—"}</Td>
                              <Td label="Status">
                                <Badge tone={STATUS_META[m.status].tone}>
                                  {STATUS_META[m.status].label}
                                </Badge>
                                {m.note ? (
                                  <p className="mt-1 text-xs text-neutral-500">{m.note}</p>
                                ) : null}
                              </Td>
                            </Tr>
                          ))}
                        </Tbody>
                      </TableShell>
                    ) : null}
                  </div>
                </>
              )}
            </section>
          ) : null}

          {step === 3 ? (
            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">Import as drafts</h3>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Creates draft requisitions in HireOps (with the job description and skills from
                  the export). Nothing is posted — each draft goes through the normal review and
                  approval flow. Rows flagged ⚠ use the fallback shown in the field mapping.
                </p>
              </div>

              {result ? (
                <Card>
                  <p className="text-sm font-semibold text-neutral-900">
                    {result.createdCount} draft requisition{result.createdCount === 1 ? "" : "s"}{" "}
                    created
                  </p>
                  <ul className="mt-3 space-y-2 text-sm">
                    {result.results.map((r) => (
                      <li key={r.jobRequisitionId} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-neutral-500">
                          {r.jobRequisitionId}
                        </span>
                        <span className="text-neutral-900">{r.title}</span>
                        {r.outcome === "created" && r.requisitionId ? (
                          <a
                            href={`/requisitions/${r.requisitionId}`}
                            className="text-brand-700 underline-offset-2 hover:underline"
                          >
                            Open draft →
                          </a>
                        ) : r.outcome === "already_imported" && r.requisitionId ? (
                          <span className="text-neutral-600">
                            Already imported —{" "}
                            <a
                              href={`/requisitions/${r.requisitionId}`}
                              className="text-brand-700 underline-offset-2 hover:underline"
                            >
                              open requisition
                            </a>
                          </span>
                        ) : (
                          <span className="text-status-warning-800">
                            Skipped{r.message ? ` — ${r.message}` : ""}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : (
                <Card>
                  <ul className="space-y-2 text-sm">
                    {rows.map((r) => (
                      <li key={r.jobRequisitionId} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-neutral-500">
                          {r.jobRequisitionId}
                        </span>
                        <span className="text-neutral-900">{r.fields["Job Posting Title"]}</span>
                        {r.alreadyImported ? (
                          <span className="text-neutral-600">
                            Already imported —{" "}
                            <a
                              href={`/requisitions/${r.alreadyImported.requisitionId}`}
                              className="text-brand-700 underline-offset-2 hover:underline"
                            >
                              open requisition
                            </a>
                          </span>
                        ) : r.needsReviewCount > 0 ? (
                          <Badge tone="warning">
                            ⚠ {r.needsReviewCount} to review after import
                          </Badge>
                        ) : (
                          <Badge tone="success">✓ Ready</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                  {importMut.error ? (
                    <p className="mt-3 text-sm text-status-error-700">
                      Import failed: {importMut.error.message}
                    </p>
                  ) : null}
                  <div className="mt-4">
                    <Button
                      disabled={pending.length === 0 || importMut.isPending || preview.isLoading}
                      onClick={() =>
                        importMut.mutate({
                          jobRequisitionIds: pending.map((r) => r.jobRequisitionId),
                        })
                      }
                    >
                      {importMut.isPending
                        ? "Importing…"
                        : pending.length === 0
                          ? "All sample rows already imported"
                          : `Import ${pending.length} as drafts`}
                    </Button>
                  </div>
                </Card>
              )}
            </section>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-neutral-200 bg-white px-6 py-3">
          <Button
            variant="ghost"
            disabled={step === 1}
            onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
          >
            Back
          </Button>
          {step < 3 ? (
            <Button onClick={() => setStep((s) => (s + 1) as Step)}>Next</Button>
          ) : (
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          )}
        </footer>
      </aside>
    </div>
  );
}
