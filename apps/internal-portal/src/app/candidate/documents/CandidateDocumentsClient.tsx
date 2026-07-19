"use client";

import { useState, type ChangeEvent } from "react";
import { Card, EmptyState } from "@/components/ui";
import { DocStatusChip } from "@/components/patterns";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { TRPCClientError } from "@trpc/client";
import type { CandidateApplicationDocumentSlot, CandidateDocumentSlot } from "@hireops/api-types";

/**
 * REST origin for the multipart upload (same resolution as the dashboard). The
 * tRPC surface runs in-process on the portal; multipart bodies go to apps/api.
 */
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/trpc$/, "") ??
  "http://localhost:3001";

const DOC_ACCEPT = ".pdf,.docx,image/jpeg,image/png,application/pdf";

async function candidateAuthHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/** Two-step upload: multipart blob → REST, then the returned key is handed to
 * the caller to attach via the appropriate tRPC mutation. */
async function uploadBlob(file: File): Promise<{
  storageKey: string;
  sizeBytes: number;
  contentType: string;
}> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/candidate-documents/upload`, {
    method: "POST",
    headers: await candidateAuthHeaders(),
    body: fd,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as { storageKey: string; sizeBytes: number; contentType: string };
}

export function CandidateDocumentsClient() {
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });
  const preOffer = trpc.candidateListMyApplicationDocuments.useQuery();
  const onboarding = trpc.candidateGetMyOnboarding.useQuery();

  if (me.isError) {
    const forbidden = me.error instanceof TRPCClientError && me.error.data?.code === "FORBIDDEN";
    return (
      <CandidateShell variant="portal" active="documents">
        <Card className="p-6">
          <EmptyState
            title={forbidden ? "This isn't a candidate account" : "We couldn't load your documents"}
            hint={forbidden ? "You're signed in, but not as a candidate." : "Please try again."}
          />
        </Card>
      </CandidateShell>
    );
  }

  const loading = preOffer.isLoading || onboarding.isLoading;
  const preOfferGroups = preOffer.data?.groups ?? [];
  const onboardingCase = onboarding.data?.case ?? null;
  const onboardingDocs = onboarding.data?.documents ?? [];
  const nothing =
    !loading && preOfferGroups.length === 0 && (!onboardingCase || onboardingDocs.length === 0);

  return (
    <CandidateShell variant="portal" active="documents">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Documents</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Upload the documents your hiring team has requested. Statuses update as they&rsquo;re
            reviewed.
          </p>
        </div>

        {loading ? (
          <Card className="p-6">
            <EmptyState title="Loading your documents…" />
          </Card>
        ) : nothing ? (
          <Card className="p-0">
            <EmptyState
              title="Nothing to upload yet"
              hint="When your hiring team requests a document, it'll appear here with an upload button."
            />
          </Card>
        ) : (
          <>
            {preOfferGroups.map((group) => (
              <section key={group.applicationId} className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Verification documents
                  {group.roleTitle ? (
                    <span className="ml-2 font-normal normal-case tracking-normal text-neutral-400">
                      · {group.roleTitle}
                    </span>
                  ) : null}
                </h2>
                <Card className="flex flex-col divide-y divide-neutral-100 p-0">
                  {group.documents.map((slot) => (
                    <PreOfferRow key={slot.documentId} slot={slot} />
                  ))}
                </Card>
              </section>
            ))}

            {onboardingCase && onboardingDocs.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Onboarding documents
                  {onboardingCase.positionTitle ? (
                    <span className="ml-2 font-normal normal-case tracking-normal text-neutral-400">
                      · {onboardingCase.positionTitle}
                    </span>
                  ) : null}
                </h2>
                <Card className="flex flex-col divide-y divide-neutral-100 p-0">
                  {onboardingDocs.map((slot) => (
                    <OnboardingRow
                      key={slot.documentTypeId}
                      caseId={onboardingCase.id}
                      slot={slot}
                    />
                  ))}
                </Card>
              </section>
            ) : null}
          </>
        )}
      </div>
    </CandidateShell>
  );
}

/** Shared row chrome: name + meta on the left, chip + reason + upload on right. */
function DocRow({
  name,
  meta,
  chip,
  reason,
  error,
  uploadLabel,
  onPickFile,
  working,
  showUpload,
}: {
  name: string;
  meta: string;
  chip: React.ReactNode;
  reason: string | null;
  error: string | null;
  uploadLabel: string;
  onPickFile: (e: ChangeEvent<HTMLInputElement>) => void;
  working: boolean;
  showUpload: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900">{name}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500">{meta}</p>
        {reason ? <p className="mt-1 text-xs text-status-error-700">Reason: {reason}</p> : null}
        {error ? (
          <p role="alert" className="mt-1 text-xs text-status-error-700">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {chip}
        {showUpload ? (
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50">
            <input
              type="file"
              accept={DOC_ACCEPT}
              className="hidden"
              onChange={onPickFile}
              disabled={working}
            />
            {working ? "Uploading…" : uploadLabel}
          </label>
        ) : null}
      </div>
    </div>
  );
}

function PreOfferRow({ slot }: { slot: CandidateApplicationDocumentSlot }) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = trpc.candidateAttachApplicationDocument.useMutation({
    onSuccess: () => void utils.candidateListMyApplicationDocuments.invalidate(),
    onError: (e) => setError(e.message),
  });
  const working = busy || attach.isPending;

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const up = await uploadBlob(file);
      await attach.mutateAsync({
        documentId: slot.documentId,
        storageKey: up.storageKey,
        fileName: file.name,
        mimeType: up.contentType,
        sizeBytes: up.sizeBytes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const meta =
    slot.status === "requested"
      ? "Requested — not uploaded yet"
      : `${slot.fileName ?? "Uploaded"}${slot.uploadedAt ? ` · ${slot.uploadedAt.slice(0, 10)}` : ""}`;

  return (
    <DocRow
      name={slot.documentTypeName ?? "Document"}
      meta={meta}
      chip={<DocStatusChip status={slot.status} />}
      reason={slot.status === "rejected" ? slot.rejectionReason : null}
      error={error}
      uploadLabel={slot.status === "requested" ? "Upload" : "Replace"}
      onPickFile={onPickFile}
      working={working}
      showUpload={slot.status !== "verified"}
    />
  );
}

function OnboardingRow({ caseId, slot }: { caseId: string; slot: CandidateDocumentSlot }) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = trpc.candidateAttachDocument.useMutation({
    onSuccess: () => void utils.candidateGetMyOnboarding.invalidate(),
    onError: (e) => setError(e.message),
  });
  const doc = slot.document;
  const working = busy || attach.isPending;

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const up = await uploadBlob(file);
      await attach.mutateAsync({
        caseId,
        documentTypeId: slot.documentTypeId,
        storageKey: up.storageKey,
        fileName: file.name,
        mimeType: up.contentType,
        sizeBytes: up.sizeBytes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  // Map the onboarding verification status onto the same chip vocabulary as the
  // pre-offer flow (requested = not yet uploaded).
  const chipStatus = !doc
    ? "requested"
    : doc.verificationStatus === "verified"
      ? "verified"
      : doc.verificationStatus === "rejected"
        ? "rejected"
        : "uploaded";

  const meta = doc
    ? `${doc.fileName ?? "Uploaded"}${doc.uploadedAt ? ` · ${doc.uploadedAt.slice(0, 10)}` : ""}`
    : "Requested — not uploaded yet";

  return (
    <DocRow
      name={slot.documentTypeName ?? "Document"}
      meta={meta}
      chip={<DocStatusChip status={chipStatus} />}
      reason={doc?.verificationStatus === "rejected" ? doc.rejectionReason : null}
      error={error}
      uploadLabel={doc ? "Replace" : "Upload"}
      onPickFile={onPickFile}
      working={working}
      showUpload={!(doc && doc.verificationStatus === "verified")}
    />
  );
}
