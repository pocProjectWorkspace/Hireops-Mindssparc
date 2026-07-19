"use client";

import { useState } from "react";
import type { ApplicationDocumentRow, RequestableDocumentType } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui";
import { DocStatusChip } from "@/components/patterns";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * ApplicationDocumentsPanel (HROPS-03) — the per-application pre-offer
 * documents block: each requested document with its status chip, preview
 * (PII-logged proxied download), verify / reject-with-reason actions, and a
 * "Request documents" affordance opening the type-picker modal.
 *
 * Exported standalone so the orchestrator can mount it as a case-detail tab
 * (HROPS-01 owns that page) — it only needs an applicationId + the documents
 * and an invalidate callback; on /hr-documents the parent list query supplies
 * both.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/trpc$/, "") ??
  "http://localhost:3001";

async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export interface ApplicationDocumentsPanelProps {
  applicationId: string;
  documents: ApplicationDocumentRow[];
  /** Called after any successful mutation so the parent can refetch. */
  onChanged: () => void;
  /** Hide the "Request documents" button (e.g. read-only mounts). */
  canRequest?: boolean;
}

export function ApplicationDocumentsPanel({
  applicationId,
  documents,
  onChanged,
  canRequest = true,
}: ApplicationDocumentsPanelProps) {
  const [requestOpen, setRequestOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {documents.length === 0 ? (
        <p className="text-sm text-neutral-500">No documents requested yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} onChanged={onChanged} />
          ))}
        </ul>
      )}
      {canRequest ? (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setRequestOpen(true)}>
            Request documents
          </Button>
        </div>
      ) : null}
      {requestOpen ? (
        <RequestDocumentsModal
          applicationId={applicationId}
          existingTypeIds={new Set(documents.map((d) => d.documentTypeId))}
          onClose={() => setRequestOpen(false)}
          onRequested={() => {
            setRequestOpen(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function DocumentRow({ doc, onChanged }: { doc: ApplicationDocumentRow; onChanged: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const verify = trpc.verifyApplicationDocument.useMutation({
    onSuccess: onChanged,
    onError: (e) => setError(e.message),
  });
  const reject = trpc.rejectApplicationDocument.useMutation({
    onSuccess: () => {
      setRejecting(false);
      setReason("");
      onChanged();
    },
    onError: (e) => setError(e.message),
  });

  const canDecide = doc.status === "uploaded" || doc.status === "rejected";
  const hasBlob = doc.status !== "requested";

  async function onPreview() {
    setError(null);
    setDownloading(true);
    try {
      const res = await fetch(`${API_BASE}/api/application-documents/${doc.id}/download`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName ?? `${doc.documentTypeName ?? "document"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-neutral-900">
            {doc.documentTypeName ?? "Document"}
          </p>
          <DocStatusChip status={doc.status} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {hasBlob ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={downloading}
              onClick={() => void onPreview()}
            >
              {downloading ? "…" : "Preview"}
            </Button>
          ) : null}
          {canDecide && doc.status !== "rejected" ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={verify.isPending}
                onClick={() => {
                  setError(null);
                  verify.mutate({ documentId: doc.id });
                }}
              >
                Verify
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={reject.isPending}
                onClick={() => setRejecting((v) => !v)}
              >
                Reject
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-neutral-500">
        {doc.status === "requested"
          ? `Requested ${doc.requestedAt.slice(0, 10)} · awaiting candidate upload`
          : `${doc.fileName ?? "File"}${doc.uploadedAt ? ` · uploaded ${doc.uploadedAt.slice(0, 10)}` : ""}`}
        {doc.status === "verified" && doc.verifierName ? (
          <span> · verified by {doc.verifierName}</span>
        ) : null}
      </p>

      {doc.status === "rejected" && doc.rejectionReason ? (
        <p className="text-xs text-status-error-700">Reason: {doc.rejectionReason}</p>
      ) : null}

      {rejecting ? (
        <div className="flex flex-col gap-2 rounded-md bg-neutral-50 p-3">
          <label className="text-xs font-medium text-neutral-700">
            Rejection reason (shown to the candidate)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </label>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={reject.isPending || reason.trim().length === 0}
              onClick={() => {
                setError(null);
                reject.mutate({ documentId: doc.id, rejectionReason: reason.trim() });
              }}
            >
              Confirm reject
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-status-error-700">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function RequestDocumentsModal({
  applicationId,
  existingTypeIds,
  onClose,
  onRequested,
}: {
  applicationId: string;
  existingTypeIds: Set<string>;
  onClose: () => void;
  onRequested: () => void;
}) {
  const types = trpc.listRequestableDocumentTypes.useQuery();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const request = trpc.requestApplicationDocuments.useMutation({
    onSuccess: onRequested,
    onError: (e) => setError(e.message),
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const items: RequestableDocumentType[] = types.data?.items ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Request documents"
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
        <div className="border-b border-neutral-100 px-5 py-4">
          <h3 className="text-base font-semibold text-neutral-900">Request documents</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            Pick the document types to request. The candidate sees them in their portal and uploads
            there; every access is PII-logged.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {types.isLoading ? (
            <p className="text-sm text-neutral-500">Loading document types…</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((t) => {
                const already = existingTypeIds.has(t.id);
                return (
                  <li key={t.id}>
                    <label
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${
                        already ? "text-neutral-400" : "cursor-pointer hover:bg-neutral-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={already}
                        checked={already || selected.has(t.id)}
                        onChange={() => toggle(t.id)}
                        className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                      />
                      <span className="min-w-0 truncate">{t.name}</span>
                      {t.geographyCode ? (
                        <span className="ml-auto shrink-0 text-[11px] uppercase text-neutral-400">
                          {t.geographyCode}
                        </span>
                      ) : null}
                      {already ? (
                        <span className="shrink-0 text-[11px] text-neutral-400">requested</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? (
            <p role="alert" className="mt-2 text-xs text-status-error-700">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size === 0 || request.isPending}
            onClick={() => {
              setError(null);
              request.mutate({ applicationId, documentTypeIds: [...selected] });
            }}
          >
            {request.isPending
              ? "Requesting…"
              : `Request${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
