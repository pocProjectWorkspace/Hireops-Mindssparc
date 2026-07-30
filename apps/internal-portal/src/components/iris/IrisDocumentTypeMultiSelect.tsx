"use client";

import { useMemo } from "react";
import { trpc } from "@/lib/trpc-client";

/**
 * IrisDocumentTypeMultiSelect — the document-type picker behind the Iris
 * `request_documents` action. Checkboxes over the tenant-agnostic
 * `document_types` catalogue (the SAME read the "Request documents" modal uses,
 * `listRequestableDocumentTypes`, gated to HR_OPS_DOC_ROLES). At least one type
 * must be checked — the drawer gates the Preview button on `value.length > 0`.
 *
 * The value is the array of selected document-type ids, exactly what
 * `requestApplicationDocuments` expects. Selection is controlled by the parent.
 */

export function IrisDocumentTypeMultiSelect({
  value,
  onChange,
  enabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  enabled: boolean;
}) {
  const query = trpc.listRequestableDocumentTypes.useQuery(undefined, { enabled });
  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  const selected = new Set(value);
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-neutral-800">
        Documents to request
        <span aria-hidden className="text-status-error-600">
          {" "}
          *
        </span>
      </label>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="px-3 py-4 text-sm text-neutral-500">Loading document types…</p>
        ) : query.error ? (
          <p className="px-3 py-4 text-sm text-status-error-700">
            Couldn&apos;t load document types.
          </p>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-neutral-500">No document types configured.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-50">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggle(t.id)}
                    className="h-4 w-4 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-neutral-800">
                      {t.name}
                    </span>
                    {t.geographyCode ? (
                      <span className="block truncate text-xs text-neutral-500">
                        {t.geographyCode}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[11px] text-neutral-400">
        Pick at least one. The candidate uploads against each request in their portal.
      </p>
    </div>
  );
}
