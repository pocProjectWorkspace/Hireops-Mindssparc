"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ListHrPoliciesOutput,
  HrPolicyDocumentRow,
  HrPolicyCategory,
  HrPolicyVersionRow,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { cn } from "@/components/ui/cn";

/**
 * /hr-policies (HROPS-03 + T12/G10) — the org's editable templates & policies
 * library. Seeded content is the CURATED STARTING library (labelled as such);
 * hr_ops + admin can author new policies, edit existing ones (each save appends
 * an immutable version snapshot), browse the version history, and archive
 * policies out of the default view. Read-only viewers see the same grid without
 * the edit affordances.
 *
 * Markdown rendering: the repo has no md renderer and the no-new-heavy-deps
 * rule holds, so renderSimpleMarkdown below handles the subset our bodies use
 * (##/### headings, - lists, **bold**, paragraphs) as REACT ELEMENTS — no
 * dangerouslySetInnerHTML, so the body text can never inject markup. The editor
 * is a plain textarea with a live preview built from the same renderer.
 */

const CATEGORY_META: Record<HrPolicyCategory, { label: string; cls: string }> = {
  offers: { label: "Offers", cls: "bg-brand-50 text-brand-700" },
  benefits: { label: "Benefits", cls: "bg-status-positive-50 text-status-positive-700" },
  policies: { label: "Policies", cls: "bg-status-info-50 text-status-info-800" },
};

const CATEGORY_KEYS = Object.keys(CATEGORY_META) as HrPolicyCategory[];

/** Inline **bold** spans → <strong>. Everything else is plain text. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-neutral-900">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

/** Minimal, safe markdown → React: headings, bullet lists, paragraphs. */
function renderSimpleMarkdown(md: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = md.split("\n");
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={key++} className="ml-5 list-disc space-y-1 text-sm text-neutral-700">
        {list.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    flushList();
    if (line.startsWith("### ")) {
      blocks.push(
        <h4 key={key++} className="mt-4 text-sm font-semibold text-neutral-900">
          {renderInline(line.slice(4))}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h3 key={key++} className="mt-5 text-base font-semibold text-neutral-900">
          {renderInline(line.slice(3))}
        </h3>,
      );
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h2 key={key++} className="mt-5 text-lg font-semibold text-neutral-900">
          {renderInline(line.slice(2))}
        </h2>,
      );
    } else if (line.trim().length > 0) {
      blocks.push(
        <p key={key++} className="text-sm leading-relaxed text-neutral-700">
          {renderInline(line)}
        </p>,
      );
    }
  }
  flushList();
  return blocks;
}

export function HrPoliciesView({ initial }: { initial: ListHrPoliciesOutput }) {
  const [category, setCategory] = useState<HrPolicyCategory | undefined>(undefined);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [openDoc, setOpenDoc] = useState<HrPolicyDocumentRow | null>(null);
  const [editing, setEditing] = useState<HrPolicyDocumentRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [historyFor, setHistoryFor] = useState<HrPolicyDocumentRow | null>(null);

  const utils = trpc.useUtils();
  const query = trpc.listHrPolicies.useQuery(
    { includeArchived },
    { initialData: includeArchived ? undefined : initial, staleTime: 5_000 },
  );
  const archive = trpc.archiveHrPolicy.useMutation();

  const allItems = query.data?.items ?? initial.items;
  const items = useMemo(
    () => (category ? allItems.filter((i) => i.category === category) : allItems),
    [allItems, category],
  );

  function refresh() {
    void utils.listHrPolicies.invalidate();
  }

  async function onArchiveToggle(doc: HrPolicyDocumentRow) {
    try {
      await archive.mutateAsync({ id: doc.id, isArchived: !doc.isArchived });
      refresh();
    } catch (err) {
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <PageHeader
        title="Templates & policies"
        subtitle="Your HR reference library — offer templates, benefits, and people policies. Edit a policy to save a new version; every change is kept in its history."
        right={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            New policy
          </Button>
        }
        className="mb-5"
      />

      {/* Category filter chips + archived toggle */}
      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCategory(undefined)}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-medium transition-colors",
            category === undefined
              ? "bg-neutral-900 text-white"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200",
          )}
        >
          All
        </button>
        {CATEGORY_KEYS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory((prev) => (prev === c ? undefined : c))}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              category === c
                ? "bg-neutral-900 text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200",
            )}
          >
            {CATEGORY_META[c].label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-neutral-600">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          <EmptyState
            className="py-14"
            title="No policy documents yet"
            hint="Start with the seeded reference library (pnpm db:seed:hr-policies), or author your first policy with “New policy”."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((doc) => (
            <PolicyCard
              key={doc.id}
              doc={doc}
              onView={() => setOpenDoc(doc)}
              onEdit={() => setEditing(doc)}
              onHistory={() => setHistoryFor(doc)}
              onArchiveToggle={() => onArchiveToggle(doc)}
              archiving={archive.isPending}
            />
          ))}
        </div>
      )}

      {openDoc ? <PolicyModal doc={openDoc} onClose={() => setOpenDoc(null)} /> : null}
      {creating ? (
        <PolicyEditor
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}
      {editing ? (
        <PolicyEditor
          mode="edit"
          doc={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
      {historyFor ? (
        <VersionHistoryModal doc={historyFor} onClose={() => setHistoryFor(null)} />
      ) : null}
    </div>
  );
}

function PolicyCard({
  doc,
  onView,
  onEdit,
  onHistory,
  onArchiveToggle,
  archiving,
}: {
  doc: HrPolicyDocumentRow;
  onView: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onArchiveToggle: () => void;
  archiving: boolean;
}) {
  const meta = CATEGORY_META[doc.category];
  return (
    <div
      className={cn(
        "flex flex-col rounded-card border border-neutral-200 bg-white p-4 shadow-card",
        doc.isArchived && "opacity-70",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
            meta.cls,
          )}
        >
          {meta.label}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          {doc.isArchived ? (
            <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-neutral-500">
              Archived
            </span>
          ) : null}
          <span>v{doc.version}</span>
          <span>· {doc.updatedAt.slice(0, 10)}</span>
        </span>
      </div>
      <h3 className="text-sm font-semibold text-neutral-900">{doc.title}</h3>
      <p className="mt-1 flex-1 text-sm text-neutral-600">{doc.summary}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onView}>
          View
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onHistory}>
          History
        </Button>
        <Button variant="ghost" size="sm" onClick={onArchiveToggle} disabled={archiving}>
          {doc.isArchived ? "Restore" : "Archive"}
        </Button>
      </div>
    </div>
  );
}

function PolicyModal({ doc, onClose }: { doc: HrPolicyDocumentRow; onClose: () => void }) {
  const meta = CATEGORY_META[doc.category];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-6 py-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  meta.cls,
                )}
              >
                {meta.label}
              </span>
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
                Version {doc.version}
              </span>
            </div>
            <h2 className="text-lg font-semibold text-neutral-900">{doc.title}</h2>
            <p className="mt-0.5 text-xs text-neutral-400">Updated {doc.updatedAt.slice(0, 10)}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-6 py-5">
          {renderSimpleMarkdown(doc.bodyMd)}
        </div>
      </div>
    </div>
  );
}

const inputCls = "rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm";

/** Create/edit a policy. On edit, the save appends a new version snapshot. */
function PolicyEditor({
  mode,
  doc,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  doc?: HrPolicyDocumentRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const create = trpc.createHrPolicy.useMutation();
  const update = trpc.updateHrPolicy.useMutation();
  const [title, setTitle] = useState(doc?.title ?? "");
  const [cat, setCat] = useState<HrPolicyCategory>(doc?.category ?? "policies");
  const [summary, setSummary] = useState(doc?.summary ?? "");
  const [bodyMd, setBodyMd] = useState(doc?.bodyMd ?? "");
  const [changeNote, setChangeNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  async function save() {
    setError(null);
    if (title.trim().length < 2) {
      setError("Give the policy a title (at least 2 characters).");
      return;
    }
    if (summary.trim().length === 0 || bodyMd.trim().length === 0) {
      setError("Both a summary and a body are required.");
      return;
    }
    try {
      if (mode === "create") {
        await create.mutateAsync({
          title: title.trim(),
          category: cat,
          summary: summary.trim(),
          bodyMd,
          changeNote: changeNote.trim() || undefined,
        });
      } else if (doc) {
        await update.mutateAsync({
          id: doc.id,
          title: title.trim(),
          category: cat,
          summary: summary.trim(),
          bodyMd,
          changeNote: changeNote.trim() || undefined,
        });
      }
      onSaved();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
      setError((prev) => prev ?? "Could not save the policy. Please try again.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "create" ? "New policy" : `Edit ${doc?.title ?? "policy"}`}
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-900">
            {mode === "create" ? "New policy" : `Edit — ${doc?.title}`}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-600">
              Title
              <input
                className={inputCls}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-600">
              Category
              <select
                className={inputCls}
                value={cat}
                onChange={(e) => setCat(e.target.value as HrPolicyCategory)}
              >
                {CATEGORY_KEYS.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_META[c].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-600 md:col-span-2">
              Summary
              <input
                className={inputCls}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-600">
              Body (Markdown — ## headings, - lists, **bold**)
              <textarea
                className={cn(inputCls, "min-h-[300px] font-mono text-xs")}
                value={bodyMd}
                onChange={(e) => setBodyMd(e.target.value)}
              />
            </label>
            <div className="flex flex-col gap-1 text-xs text-neutral-600">
              Preview
              <div className="min-h-[300px] space-y-2 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
                {bodyMd.trim() ? (
                  renderSimpleMarkdown(bodyMd)
                ) : (
                  <p className="text-sm text-neutral-400">Nothing to preview yet.</p>
                )}
              </div>
            </div>
          </div>

          <label className="mt-4 flex flex-col gap-1 text-xs text-neutral-600">
            Change note (optional — why this edit; stored in the version history)
            <input
              className={inputCls}
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder={mode === "create" ? "Initial version" : "e.g. Updated leave accrual"}
            />
          </label>

          {error ? <p className="mt-3 text-xs text-status-error-700">{error}</p> : null}
        </div>
        <div className="flex items-center gap-2 border-t border-neutral-100 px-6 py-4">
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create policy" : "Save new version"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function VersionHistoryModal({ doc, onClose }: { doc: HrPolicyDocumentRow; onClose: () => void }) {
  const q = trpc.listHrPolicyVersions.useQuery(
    { policyId: doc.id },
    { refetchOnWindowFocus: false, staleTime: 10_000 },
  );
  const [open, setOpen] = useState<HrPolicyVersionRow | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const versions = q.data?.items ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Version history — ${doc.title}`}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-neutral-900">Version history</h2>
            <p className="text-xs text-neutral-500">{doc.title}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {q.isLoading ? (
            <p className="py-2 text-sm text-neutral-500">Loading versions…</p>
          ) : q.error ? (
            <p className="py-2 text-sm text-status-error-600">Couldn&rsquo;t load versions.</p>
          ) : versions.length === 0 ? (
            <p className="py-2 text-sm text-neutral-500">
              No saved versions yet — this policy hasn&rsquo;t been edited since versioning began.
            </p>
          ) : (
            <ol className="space-y-2">
              {versions.map((v) => (
                <li key={v.id} className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-900">v{v.version}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-600">
                      {v.changeNote ?? "No change note"}
                    </span>
                    <span className="text-xs text-neutral-400">{v.createdAt.slice(0, 10)}</span>
                    <button
                      type="button"
                      onClick={() => setOpen(open?.id === v.id ? null : v)}
                      className="text-xs font-medium text-brand-700 hover:underline"
                    >
                      {open?.id === v.id ? "Hide" : "View"}
                    </button>
                  </div>
                  {open?.id === v.id ? (
                    <div className="mt-2 space-y-2 border-t border-neutral-100 pt-2">
                      <p className="text-xs text-neutral-500">{v.summary}</p>
                      <div className="space-y-2">{renderSimpleMarkdown(v.bodyMd)}</div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
