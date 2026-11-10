"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import Link from "next/link";
import {
  BULK_CV_ATTESTATION_TEXT,
  type BulkCvItemRow,
  type BulkCvItemStatus,
  type BulkCvUploadResponse,
} from "@hireops/api-types";
import { Badge, Button, TableShell, Tbody, Td, Th, Thead, Tr } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * PC-2 — "Upload CVs" drawer for one requisition.
 *
 * The recruiter drops PDF / DOCX files or .zip archives. Files go to
 * POST /api/upload/bulk-cv in chunks (one batch, several requests — the first
 * creates the batch, later ones pass its id), then the drawer polls
 * getBulkCvBatch while the worker drain parses them. Per-file status, totals,
 * duplicates linked to the existing candidate, and Retry for failures.
 *
 * Candidates created this way are NOT emailed (they did not apply) — the copy
 * says so, and the attestation is the processing basis the batch records.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/trpc$/, "") ??
  "http://localhost:3001";

const ACCEPT = ".pdf,.docx,.zip,application/pdf,application/zip";

/** Keep each request modest so a 400-CV drop is many small posts, not one huge one. */
const CHUNK_MAX_FILES = 20;
const CHUNK_MAX_BYTES = 40 * 1024 * 1024;

async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

const STATUS_META: Record<BulkCvItemStatus, { tone: BadgeTone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  parsing: { tone: "info", label: "Reading CV…" },
  created: { tone: "success", label: "Added" },
  duplicate: { tone: "warning", label: "Duplicate" },
  failed: { tone: "error", label: "Failed" },
  skipped: { tone: "neutral", label: "Skipped" },
};

const REASON_LABEL: Record<string, string> = {
  new_candidate: "New candidate",
  existing_candidate: "Existing candidate, added to this role",
  already_on_requisition: "Already on this role",
  same_file_in_batch: "Same file uploaded twice",
  unreadable_cv: "Could not read this CV (scanned image or unreadable text)",
  no_contact_details: "No email or phone found in the CV",
  requisition_not_accepting: "Role is not open for candidates",
  file_missing: "Stored file not found",
  storage_failed: "Upload to storage failed — upload it again",
  too_large: "Larger than the per-file limit",
  empty_file: "Empty file",
  legacy_doc_not_supported: "Old .doc format — save as PDF or DOCX",
  not_a_valid_file: "File content does not match its type",
  not_a_cv_type: "Not a PDF or DOCX",
  unsafe_path: "Unsafe file name in archive",
  nested_archive: "Archive inside an archive",
  encrypted: "Password-protected",
  unsupported_compression: "Unsupported zip compression",
  suspicious_compression: "Suspicious compression ratio",
  corrupt_entry: "Damaged file in archive",
  corrupt_archive: "Damaged archive",
  not_a_zip: "Not a valid zip",
  archive_too_large: "Archive larger than the batch limit",
  too_many_entries: "Archive has too many files",
  zip64_not_supported: "Archive format not supported (zip64)",
  batch_size_exceeded: "Batch size limit reached",
};

function reasonLabel(code: string | null): string {
  if (!code) return "";
  return REASON_LABEL[code] ?? code;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function chunkFiles(files: File[]): File[][] {
  const chunks: File[][] = [];
  let cur: File[] = [];
  let bytes = 0;
  for (const f of files) {
    if (cur.length > 0 && (cur.length >= CHUNK_MAX_FILES || bytes + f.size > CHUNK_MAX_BYTES)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += f.size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

const UPLOAD_ERROR_LABEL: Record<string, string> = {
  too_many_files: "This upload would take the batch over its file limit.",
  requisition_not_accepting: "This role is not open for candidates.",
  attestation_required: "Confirm the processing basis before uploading.",
  forbidden: "Your role cannot upload CVs.",
  unauthorized: "Your session expired — sign in again.",
  no_files: "No files selected.",
};

export function BulkCvUploadButton({
  requisitionId,
  roleTitle,
  size = "md",
}: {
  requisitionId: string;
  roleTitle: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size={size} onClick={() => setOpen(true)}>
        Upload CVs
      </Button>
      {open ? (
        <BulkCvUploadDrawer
          requisitionId={requisitionId}
          roleTitle={roleTitle}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function BulkCvUploadDrawer({
  requisitionId,
  roleTitle,
  onClose,
}: {
  requisitionId: string;
  roleTitle: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [attested, setAttested] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !uploading) close();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [close, uploading]);

  const list = trpc.listBulkCvBatches.useQuery({ requisitionId });
  const limits = list.data?.limits;
  const accepting = list.data?.acceptingUploads ?? true;

  const batch = trpc.getBulkCvBatch.useQuery(
    { batchId: batchId ?? "" },
    {
      enabled: batchId !== null,
      // Poll while anything is still queued / being read.
      refetchInterval: (q) => (q.state.data && q.state.data.batch.done ? false : 2000),
    },
  );
  const retry = trpc.retryBulkCvItems.useMutation({
    onSuccess: async () => {
      await batch.refetch();
    },
  });

  // When a batch finishes, refresh the candidate lists behind the drawer.
  const done = batch.data?.batch.done ?? false;
  useEffect(() => {
    if (done) void utils.listCandidatesByRequisition.invalidate();
  }, [done, utils]);

  const totalBytes = useMemo(() => files.reduce((n, f) => n + f.size, 0), [files]);

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    setError(null);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...Array.from(incoming).filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    addFiles(e.target.files);
    e.target.value = "";
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }

  async function upload() {
    if (files.length === 0) return;
    if (!attested && !batchId) {
      setError(UPLOAD_ERROR_LABEL.attestation_required ?? null);
      return;
    }
    if (limits && totalBytes > limits.maxBatchBytes) {
      setError(`Total size is over the ${formatBytes(limits.maxBatchBytes)} batch limit.`);
      return;
    }
    setError(null);
    const chunks = chunkFiles(files);
    setUploading({ done: 0, total: chunks.length });
    let currentBatch = batchId;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const fd = new FormData();
        fd.append("requisitionId", requisitionId);
        if (currentBatch) fd.append("batchId", currentBatch);
        else fd.append("attested", attested ? "true" : "false");
        for (const f of chunks[i] ?? []) fd.append("files", f, f.name);
        const res = await fetch(`${API_BASE}/api/upload/bulk-cv`, {
          method: "POST",
          headers: await authHeaders(),
          body: fd,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const code = body.error ?? `http_${res.status}`;
          throw new Error(UPLOAD_ERROR_LABEL[code] ?? `Upload failed (${code})`);
        }
        const json = (await res.json()) as BulkCvUploadResponse;
        currentBatch = json.batchId;
        setBatchId(json.batchId);
        setUploading({ done: i + 1, total: chunks.length });
      }
      setFiles([]);
      await list.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  const counts = batch.data?.batch.counts;
  const processed = counts ? counts.created + counts.duplicate + counts.failed + counts.skipped : 0;
  const pct = counts && counts.total > 0 ? Math.round((processed / counts.total) * 100) : 0;
  const retryable = (batch.data?.items ?? []).filter((i) => i.retryable);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Upload CVs for ${roleTitle}`}
      className="fixed inset-0 z-modal flex justify-end"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={() => (uploading ? undefined : close())}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[56rem] max-w-[96vw] flex-col overflow-hidden bg-neutral-50 shadow-3">
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-neutral-900">Upload CVs</h2>
            <p className="mt-0.5 truncate text-xs text-neutral-500">
              {roleTitle} · PDF or DOCX, or a .zip of them
              {limits
                ? ` · up to ${limits.maxFilesPerBatch} files / ${formatBytes(limits.maxBatchBytes)} per batch, ${formatBytes(limits.maxFileBytes)} per file`
                : ""}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={close} disabled={uploading !== null}>
            Close
          </Button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {!accepting ? (
            <div className="rounded-card border border-status-warning-200 bg-status-warning-50 px-4 py-2 text-sm text-status-warning-800">
              This role is not open for candidates, so CVs cannot be added to it.
            </div>
          ) : (
            <section className="space-y-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={
                  dragOver
                    ? "rounded-card border-2 border-dashed border-brand-500 bg-brand-50 px-6 py-8 text-center"
                    : "rounded-card border-2 border-dashed border-neutral-300 bg-white px-6 py-8 text-center"
                }
              >
                <p className="text-sm text-neutral-700">Drop CVs or a .zip here</p>
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => inputRef.current?.click()}
                    disabled={uploading !== null}
                  >
                    Choose files
                  </Button>
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept={ACCEPT}
                    className="hidden"
                    onChange={onPick}
                  />
                </div>
                {files.length > 0 ? (
                  <p className="mt-3 text-xs text-neutral-600">
                    {files.length} {files.length === 1 ? "file" : "files"} selected ·{" "}
                    {formatBytes(totalBytes)}{" "}
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() => setFiles([])}
                      disabled={uploading !== null}
                    >
                      Clear
                    </button>
                  </p>
                ) : null}
              </div>

              {!batchId ? (
                <label className="flex items-start gap-2 text-xs text-neutral-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={attested}
                    onChange={(e) => setAttested(e.target.checked)}
                  />
                  <span>{BULK_CV_ATTESTATION_TEXT}</span>
                </label>
              ) : null}

              {error ? (
                <div className="rounded-card border border-status-error-200 bg-status-error-50 px-4 py-2 text-sm text-status-error-700">
                  {error}
                </div>
              ) : null}

              <div className="flex items-center gap-3">
                <Button
                  onClick={upload}
                  disabled={files.length === 0 || uploading !== null || (!attested && !batchId)}
                >
                  {uploading
                    ? `Uploading ${uploading.done}/${uploading.total}…`
                    : batchId
                      ? `Add ${files.length} to this batch`
                      : `Upload ${files.length} ${files.length === 1 ? "file" : "files"}`}
                </Button>
                {batchId ? (
                  <button
                    type="button"
                    className="text-xs text-neutral-600 underline"
                    onClick={() => {
                      setBatchId(null);
                      setAttested(false);
                    }}
                    disabled={uploading !== null}
                  >
                    Start a new batch
                  </button>
                ) : null}
              </div>
            </section>
          )}

          {batchId && batch.data ? (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-neutral-900">
                  {processed} of {counts?.total ?? 0} processed
                </span>
                {counts ? (
                  <>
                    <Badge tone="success">{counts.created} added</Badge>
                    <Badge tone="warning">{counts.duplicate} duplicate</Badge>
                    <Badge tone="error">{counts.failed} failed</Badge>
                    <Badge tone="neutral">{counts.skipped} skipped</Badge>
                    {counts.queued + counts.parsing > 0 ? (
                      <Badge tone="info">{counts.queued + counts.parsing} in queue</Badge>
                    ) : null}
                  </>
                ) : null}
                {retryable.length > 0 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => retry.mutate({ batchId })}
                    disabled={retry.isPending}
                  >
                    Retry {retryable.length} failed
                  </Button>
                ) : null}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-200">
                <div className="h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <ItemTable
                items={batch.data.items}
                onRetry={(id) => retry.mutate({ batchId, itemIds: [id] })}
                retryPending={retry.isPending}
              />
            </section>
          ) : null}

          {(list.data?.batches.length ?? 0) > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-neutral-900">Recent uploads</h3>
              <ul className="space-y-1 text-xs">
                {list.data?.batches.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setBatchId(b.id)}
                      className={
                        b.id === batchId
                          ? "w-full rounded-button bg-brand-50 px-3 py-2 text-left text-brand-800"
                          : "w-full rounded-button px-3 py-2 text-left text-neutral-700 hover:bg-neutral-100"
                      }
                    >
                      {new Date(b.createdAt).toLocaleString()} · {b.uploadedByName ?? "—"} ·{" "}
                      {b.counts.total} files · {b.counts.created} added · {b.counts.duplicate}{" "}
                      duplicate · {b.counts.failed} failed
                      {b.done ? "" : " · in progress"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function ItemTable({
  items,
  onRetry,
  retryPending,
}: {
  items: BulkCvItemRow[];
  onRetry: (id: string) => void;
  retryPending: boolean;
}) {
  return (
    <TableShell>
      <Thead>
        <Th>File</Th>
        <Th>Status</Th>
        <Th>Detail</Th>
        <Th numeric>Action</Th>
      </Thead>
      <Tbody>
        {items.map((i) => {
          const meta = STATUS_META[i.status];
          const link =
            i.candidateId && i.applicationId
              ? `/candidates?candidateId=${i.candidateId}&applicationId=${i.applicationId}`
              : null;
          return (
            <Tr key={i.id}>
              <Td>
                <span className="block max-w-[22rem] truncate text-xs" title={i.fileName}>
                  {i.fileName}
                </span>
              </Td>
              <Td label="Status">
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </Td>
              <Td label="Detail" className="text-xs text-neutral-600">
                {link ? (
                  <Link href={link} className="text-brand-700 underline">
                    {i.candidateName ?? "View candidate"}
                  </Link>
                ) : null}
                {link && (i.outcomeDetail || i.failureReason) ? " · " : null}
                {reasonLabel(i.outcomeDetail ?? i.failureReason)}
              </Td>
              <Td label="Action">
                {i.retryable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRetry(i.id)}
                    disabled={retryPending}
                  >
                    Retry
                  </Button>
                ) : null}
              </Td>
            </Tr>
          );
        })}
      </Tbody>
    </TableShell>
  );
}
