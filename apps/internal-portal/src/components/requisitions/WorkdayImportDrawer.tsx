"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  WORKDAY_COLUMN_ALIASES,
  WORKDAY_UPLOAD_EXTENSIONS,
  WORKDAY_UPLOAD_MAX_BYTES,
  WORKDAY_UPLOAD_MAX_ROWS,
  type ImportWorkdayRequisitionsOutput,
  type PreviewWorkdayRequisitionImportOutput,
  type WorkdayMappingStatus,
  type WorkdayPreviewRow,
  type WorkdayUploadFile,
} from "@hireops/api-types";
import { Badge, Button, Card, TableShell, Tbody, Td, Th, Thead, Tr } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { useTenantBranding } from "@/components/nav/TenantBrandingProvider";
import { trpc } from "@/lib/trpc-client";

/**
 * "Import from Workday" drawer (requisitions list header).
 *
 * HONESTY: there is NO live Workday connection. Step 1 explains the connection
 * options; step 2 previews a Workday requisition report EXPORT the user
 * uploads (CSV / XLSX, parsed server-side) — or, for demos, a built-in sample —
 * with a field mapping validated server-side against this tenant's real
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

const PAGE_SIZE = 25;
const MAX_MB = WORKDAY_UPLOAD_MAX_BYTES / (1024 * 1024);
const REQUIRED_COLUMNS = WORKDAY_COLUMN_ALIASES.filter((c) => c.required).map((c) => c.label);
const OPTIONAL_COLUMNS = WORKDAY_COLUMN_ALIASES.filter((c) => !c.required).map((c) => c.label);

function connectionOptions(orgName: string) {
  return [
    {
      title: "Workday report pull",
      body: `A read-only Workday custom report (RaaS) or API that HireOps reads on a schedule. Best long-term option; needs ${orgName}'s Workday team to grant access.`,
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
}

const STATUS_META: Record<WorkdayMappingStatus, { tone: BadgeTone; label: string }> = {
  mapped: { tone: "success", label: "✓ Mapped" },
  needs_review: { tone: "warning", label: "⚠ Needs review" },
  not_imported: { tone: "neutral", label: "Not imported" },
};

type Source = { kind: "sample" } | { kind: "upload"; file: WorkdayUploadFile };

/** Browser File → base64 (chunked so large files don't blow the call stack). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function RowStatus({ row }: { row: WorkdayPreviewRow }) {
  if (row.alreadyImported) return <Badge tone="neutral">Already imported</Badge>;
  if (row.needsReviewCount > 0) {
    return <Badge tone="warning">⚠ {row.needsReviewCount} to review</Badge>;
  }
  return <Badge tone="success">✓ Ready</Badge>;
}

function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <div className="flex items-center justify-between text-xs text-neutral-600">
      <span>
        Rows {from}–{to} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function CountTiles({ counts }: { counts: PreviewWorkdayRequisitionImportOutput["counts"] }) {
  const tiles: { label: string; value: number; tone: string }[] = [
    { label: "Requisitions", value: counts.total, tone: "text-neutral-900" },
    { label: "✓ Ready", value: counts.ready, tone: "text-status-success-700" },
    { label: "⚠ Needs review", value: counts.needsReview, tone: "text-status-warning-800" },
    { label: "Already imported", value: counts.alreadyImported, tone: "text-neutral-600" },
    { label: "Can't import", value: counts.invalid, tone: "text-status-error-700" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-card border border-neutral-200 bg-white px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            {t.label}
          </p>
          <p className={`text-lg font-semibold tabular-nums ${t.tone}`}>{t.value}</p>
        </div>
      ))}
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
  const branding = useTenantBranding();
  const orgName = branding?.displayName?.trim() || "your organisation";
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<Source | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<ImportWorkdayRequisitionsOutput | null>(null);
  const [resultPage, setResultPage] = useState(0);

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

  const samplePreview = trpc.previewWorkdayRequisitionImport.useQuery(undefined, {
    enabled: source?.kind === "sample",
  });
  const uploadPreview = trpc.previewWorkdayRequisitionUpload.useMutation();
  const importMut = trpc.importWorkdayRequisitions.useMutation({
    onSuccess: async (data) => {
      setResult(data);
      setResultPage(0);
      await Promise.all([
        utils.previewWorkdayRequisitionImport.invalidate(),
        utils.listMyRequisitionsV2.invalidate(),
      ]);
      // Refresh the upload preview so "already imported" reflects the import.
      if (source?.kind === "upload") uploadPreview.mutate({ file: source.file });
      router.refresh();
    },
  });

  const active =
    source?.kind === "sample"
      ? {
          data: samplePreview.data,
          isLoading: samplePreview.isLoading,
          error: samplePreview.error?.message ?? null,
        }
      : source?.kind === "upload"
        ? {
            data: uploadPreview.data,
            isLoading: uploadPreview.isPending && !uploadPreview.data,
            error: uploadPreview.error?.message ?? null,
          }
        : { data: undefined, isLoading: false, error: null };

  const preview = active.data;
  const rows = useMemo(() => preview?.rows ?? [], [preview]);
  const columns = preview?.columns ?? [];
  const pending = rows.filter((r) => !r.alreadyImported);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const current = rows.find((r) => r.jobRequisitionId === selectedId) ?? rows[0];
  const isSample = source?.kind === "sample";

  const resetPreviewState = () => {
    setSelectedId(null);
    setPage(0);
    setResult(null);
    importMut.reset();
  };

  const onPickFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!WORKDAY_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setFileError("Upload a Workday export as a .csv or .xlsx file.");
      return;
    }
    if (file.size > WORKDAY_UPLOAD_MAX_BYTES) {
      setFileError(`The file is larger than ${MAX_MB} MB. Split the export into smaller files.`);
      return;
    }
    const upload: WorkdayUploadFile = {
      fileName: file.name,
      contentBase64: await fileToBase64(file),
    };
    resetPreviewState();
    setSource({ kind: "upload", file: upload });
    uploadPreview.mutate({ file: upload });
  };

  const chooseSample = () => {
    setFileError(null);
    resetPreviewState();
    uploadPreview.reset();
    setSource({ kind: "sample" });
  };

  const sourceLabel = isSample
    ? "the built-in sample export (demo data)"
    : source?.kind === "upload"
      ? `"${source.file.fileName}"`
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import from Workday"
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
              <Badge tone="info">File import</Badge>
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              No live Workday connection — upload a Workday requisition report export (CSV or
              Excel).
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
          {isSample ? (
            <div className="rounded-card border border-status-warning-200 bg-status-warning-50 px-4 py-2 text-xs font-medium text-status-warning-800">
              Demo data — this preview uses the built-in sample Workday export, not {orgName}&apos;s
              requisitions.
            </div>
          ) : null}

          {step === 1 ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-neutral-900">How it connects</h3>
              <div className="grid gap-3 md:grid-cols-3">
                {connectionOptions(orgName).map((o, i) => (
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
                Until one of these is set up, export the open-requisitions report from Workday and
                upload the file in the next step.
              </p>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="space-y-5">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-neutral-900">
                      Upload Workday export
                    </h3>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      .csv or .xlsx (first sheet), up to {MAX_MB} MB and{" "}
                      {WORKDAY_UPLOAD_MAX_ROWS.toLocaleString("en-US")} requisitions. Required
                      columns: {REQUIRED_COLUMNS.join(", ")}. Also read:{" "}
                      {OPTIONAL_COLUMNS.join(", ")} (common Workday header variants are recognised).
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <input
                      ref={fileInput}
                      type="file"
                      accept={WORKDAY_UPLOAD_EXTENSIONS.join(",")}
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        void onPickFile(f);
                      }}
                    />
                    <Button onClick={() => fileInput.current?.click()}>
                      {source?.kind === "upload" ? "Upload another file" : "Choose file…"}
                    </Button>
                    <Button variant="ghost" onClick={chooseSample}>
                      Use sample data (demo)
                    </Button>
                  </div>
                </div>
                {fileError ? (
                  <p className="mt-3 text-sm text-status-error-700">{fileError}</p>
                ) : null}
              </Card>

              {!source ? (
                <p className="text-sm text-neutral-500">
                  Choose a Workday export to preview how it maps into HireOps.
                </p>
              ) : active.isLoading ? (
                <p className="text-sm text-neutral-500">Reading and checking {sourceLabel}…</p>
              ) : active.error ? (
                <p className="rounded-card border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
                  Couldn&apos;t preview {sourceLabel}: {active.error}
                </p>
              ) : preview ? (
                <>
                  <div>
                    <h3 className="text-sm font-semibold text-neutral-900">
                      {isSample ? "Sample Workday export" : `Workday export ${sourceLabel}`}
                    </h3>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      Checked just now against this workspace&apos;s business units, people and comp
                      bands.
                    </p>
                  </div>
                  <CountTiles counts={preview.counts} />

                  {preview.unmappedColumns.length > 0 ? (
                    <p className="text-xs text-neutral-600">
                      <span className="font-semibold">Columns not imported:</span>{" "}
                      {preview.unmappedColumns.join(", ")}
                    </p>
                  ) : null}

                  {preview.rowErrors.length > 0 ? (
                    <details className="rounded-card border border-status-error-200 bg-white px-4 py-2 text-sm">
                      <summary className="cursor-pointer font-medium text-status-error-700">
                        {preview.rowErrors.length} row{preview.rowErrors.length === 1 ? "" : "s"}{" "}
                        can&apos;t be imported
                      </summary>
                      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-neutral-700">
                        {preview.rowErrors.map((e) => (
                          <li key={e.rowNumber}>
                            Row {e.rowNumber}
                            {e.jobRequisitionId ? ` (${e.jobRequisitionId})` : ""}: {e.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  {rows.length > 0 ? (
                    <>
                      <TableShell className="max-h-[28rem] overflow-y-auto">
                        <Thead>
                          <Th className="whitespace-nowrap">Row</Th>
                          <Th className="whitespace-nowrap">Status</Th>
                          {columns.map((c) => (
                            <Th key={c} className="whitespace-nowrap">
                              {c}
                            </Th>
                          ))}
                        </Thead>
                        <Tbody>
                          {pageRows.map((r) => (
                            <Tr
                              key={r.jobRequisitionId}
                              onClick={() => setSelectedId(r.jobRequisitionId)}
                              className={
                                current?.jobRequisitionId === r.jobRequisitionId
                                  ? "cursor-pointer bg-brand-50 lg:bg-brand-50"
                                  : "cursor-pointer"
                              }
                            >
                              <Td label="Row" className="whitespace-nowrap tabular-nums">
                                {r.rowNumber}
                              </Td>
                              <Td label="Status" className="whitespace-nowrap">
                                <RowStatus row={r} />
                              </Td>
                              {columns.map((c) => (
                                <Td key={c} label={c} className="whitespace-nowrap">
                                  {r.fields[c] || "—"}
                                </Td>
                              ))}
                            </Tr>
                          ))}
                        </Tbody>
                      </TableShell>
                      <Pager
                        page={page}
                        pageCount={pageCount}
                        total={rows.length}
                        onPage={setPage}
                      />
                    </>
                  ) : (
                    <p className="text-sm text-neutral-500">No importable rows in this file.</p>
                  )}

                  {current ? (
                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-semibold text-neutral-900">
                          Field mapping — {current.jobRequisitionId} ·{" "}
                          {current.fields["Job Posting Title"]}
                        </h3>
                        <p className="mt-0.5 text-xs text-neutral-500">
                          Click a row above to see its mapping.
                        </p>
                      </div>
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
                              <Td label="Workday value">{m.workdayValue || "—"}</Td>
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
                    </div>
                  ) : null}
                </>
              ) : null}
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
                  Re-importing the same Workday requisition is skipped as already imported.
                </p>
              </div>

              {!source || !preview ? (
                <Card>
                  <p className="text-sm text-neutral-600">
                    {active.error
                      ? `Couldn't preview ${sourceLabel}: ${active.error}`
                      : active.isLoading
                        ? `Reading ${sourceLabel}…`
                        : "Upload a Workday export (or use the sample) in step 2 first."}
                  </p>
                  {!source || active.error ? (
                    <div className="mt-3">
                      <Button variant="secondary" onClick={() => setStep(2)}>
                        Go to step 2
                      </Button>
                    </div>
                  ) : null}
                </Card>
              ) : result ? (
                <Card>
                  <p className="text-sm font-semibold text-neutral-900">
                    {result.createdCount} draft requisition{result.createdCount === 1 ? "" : "s"}{" "}
                    created
                    {result.alreadyImportedCount > 0
                      ? ` · ${result.alreadyImportedCount} already imported`
                      : ""}
                    {result.skippedCount > 0 ? ` · ${result.skippedCount} skipped` : ""}
                  </p>
                  <ul className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto text-sm">
                    {result.results
                      .slice(resultPage * PAGE_SIZE, (resultPage + 1) * PAGE_SIZE)
                      .map((r) => (
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
                  <div className="mt-3">
                    <Pager
                      page={resultPage}
                      pageCount={Math.max(1, Math.ceil(result.results.length / PAGE_SIZE))}
                      total={result.results.length}
                      onPage={setResultPage}
                    />
                  </div>
                </Card>
              ) : (
                <Card>
                  <CountTiles counts={preview.counts} />
                  <p className="mt-3 text-sm text-neutral-700">
                    {pending.length} requisition{pending.length === 1 ? "" : "s"} from {sourceLabel}{" "}
                    will be created as drafts
                    {preview.counts.needsReview > 0
                      ? ` (${preview.counts.needsReview} with fields to review after import)`
                      : ""}
                    .
                    {preview.counts.alreadyImported > 0
                      ? ` ${preview.counts.alreadyImported} already imported will be skipped.`
                      : ""}
                  </p>
                  {importMut.error ? (
                    <p className="mt-3 text-sm text-status-error-700">
                      Import failed: {importMut.error.message}
                    </p>
                  ) : null}
                  <div className="mt-4">
                    <Button
                      disabled={pending.length === 0 || importMut.isPending}
                      onClick={() =>
                        importMut.mutate({
                          jobRequisitionIds: pending.map((r) => r.jobRequisitionId),
                          file: source.kind === "upload" ? source.file : undefined,
                        })
                      }
                    >
                      {importMut.isPending
                        ? `Importing ${pending.length}…`
                        : pending.length === 0
                          ? "All rows already imported"
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
