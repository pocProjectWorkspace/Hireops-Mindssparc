"use client";

import { useMemo, useState, type ReactNode } from "react";
import type {
  ListHrPoliciesOutput,
  HrPolicyDocumentRow,
  HrPolicyCategory,
} from "@hireops/api-types";
import { Button, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { cn } from "@/components/ui/cn";

/**
 * /hr-policies (HROPS-03) — the curated templates & policies library. Read-only
 * card grid (category chip, title, summary, updated date) + a View panel that
 * renders the markdown body. Content is CURATED REFERENCE material seeded by
 * db:seed:hr-policies and labelled as such — not legal advice, not AI-generated.
 *
 * Markdown rendering: the repo has no md renderer and the no-new-heavy-deps
 * rule holds, so renderSimpleMarkdown below handles the subset our curated
 * bodies use (##/### headings, - lists, **bold**, paragraphs) as REACT
 * ELEMENTS — no dangerouslySetInnerHTML, so the body text can never inject
 * markup.
 */

const CATEGORY_META: Record<HrPolicyCategory, { label: string; cls: string }> = {
  offers: { label: "Offers", cls: "bg-brand-50 text-brand-700" },
  benefits: { label: "Benefits", cls: "bg-status-positive-50 text-status-positive-700" },
  policies: { label: "Policies", cls: "bg-status-info-50 text-status-info-800" },
};

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
  const [openDoc, setOpenDoc] = useState<HrPolicyDocumentRow | null>(null);

  const items = useMemo(
    () => (category ? initial.items.filter((i) => i.category === category) : initial.items),
    [initial.items, category],
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <PageHeader
        title="Templates & policies"
        subtitle="The HR reference library — offer templates, benefits, and people policies."
        right={
          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-600">
            Curated reference content
          </span>
        }
        className="mb-5"
      />

      {/* Category filter chips */}
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
        {(Object.keys(CATEGORY_META) as HrPolicyCategory[]).map((c) => (
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
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          <EmptyState
            className="py-14"
            title="No policy documents yet"
            hint="The policy library is seeded reference content. Run the hr-policies seed to populate it."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((doc) => (
            <PolicyCard key={doc.id} doc={doc} onView={() => setOpenDoc(doc)} />
          ))}
        </div>
      )}

      {openDoc ? <PolicyModal doc={openDoc} onClose={() => setOpenDoc(null)} /> : null}
    </div>
  );
}

function PolicyCard({ doc, onView }: { doc: HrPolicyDocumentRow; onView: () => void }) {
  const meta = CATEGORY_META[doc.category];
  return (
    <div className="flex flex-col rounded-card border border-neutral-200 bg-white p-4 shadow-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
            meta.cls,
          )}
        >
          {meta.label}
        </span>
        <span className="text-[11px] text-neutral-400">Updated {doc.updatedAt.slice(0, 10)}</span>
      </div>
      <h3 className="text-sm font-semibold text-neutral-900">{doc.title}</h3>
      <p className="mt-1 flex-1 text-sm text-neutral-600">{doc.summary}</p>
      <div className="mt-3">
        <Button variant="secondary" size="sm" onClick={onView}>
          View
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
                Curated reference content
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
