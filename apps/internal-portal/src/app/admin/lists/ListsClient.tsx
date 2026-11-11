"use client";

import { useState } from "react";
import {
  TENANT_LOOKUP_KEY_RE,
  slugKey,
  type ListTenantLookupsOutput,
  type ResolvedLookupEntry,
  type TenantLookupKind,
  type TenantLookupKindView,
} from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Lists (C1-F3) — the tenant's values over the PLATFORM DEFAULT lists.
 *
 * Every list starts from the platform values (shown as "Platform default").
 * Renaming, reordering or switching one off stores an override ("Changed");
 * "Reset" puts the platform value back. Values the organisation adds are its
 * own ("Added") and can be switched off but not deleted, because records keep
 * the value's key. Keys never change, so reports stay comparable.
 *
 * Attributes are optional `name=value` pairs (e.g. `hasDuration=true` on an
 * employment type). hr_head sees the page read-only.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

function attrsToText(attrs: ResolvedLookupEntry["attrs"]): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}

/** "a=1, b=true, c=text" → flat scalar attrs. Invalid pairs are skipped. */
function textToAttrs(text: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const part of text.split(",")) {
    const [rawK, ...rest] = part.split("=");
    const k = rawK?.trim();
    const v = rest.join("=").trim();
    if (!k || !v) continue;
    if (v === "true" || v === "false") out[k] = v === "true";
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else out[k] = v.slice(0, 200);
  }
  return out;
}

interface EditState {
  key: string;
  label: string;
  sortOrder: string;
  attrs: string;
  isActive: boolean;
}

function SourcePill({ e }: { e: ResolvedLookupEntry }) {
  const text =
    e.source === "platform" ? "Platform default" : e.source === "override" ? "Changed" : "Added";
  const cls =
    e.source === "platform"
      ? "border-neutral-200 bg-neutral-50 text-neutral-500"
      : "border-brand-200 bg-brand-50 text-brand-700";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {text}
    </span>
  );
}

function KindCard({
  view,
  canEdit,
  onSaved,
  onError,
}: {
  view: TenantLookupKindView;
  canEdit: boolean;
  onSaved: (text: string) => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [draft, setDraft] = useState({ label: "", key: "", sortOrder: "" });

  const upsert = trpc.upsertTenantLookup.useMutation({
    onSuccess: async () => {
      setEdit(null);
      setDraft({ label: "", key: "", sortOrder: "" });
      await onSaved(`Saved ${view.label.toLowerCase()}.`);
    },
    onError,
  });
  const reset = trpc.resetTenantLookup.useMutation({
    onSuccess: async () => onSaved(`Reset to the platform value.`),
    onError,
  });
  const busy = upsert.isPending || reset.isPending;
  const kind = view.kind as TenantLookupKind;

  const save = (e: ResolvedLookupEntry, patch: Partial<EditState>) => {
    const next: EditState = {
      key: e.key,
      label: e.label,
      sortOrder: String(e.sortOrder),
      attrs: attrsToText(e.attrs),
      isActive: e.isActive,
      ...patch,
    };
    upsert.mutate({
      kind,
      key: next.key,
      label: next.label.trim(),
      sortOrder: Number(next.sortOrder) || 0,
      isActive: next.isActive,
      attrs: textToAttrs(next.attrs),
    });
  };

  const newKey = draft.key.trim() || slugKey(draft.label);
  const keyTaken = view.entries.some((e) => e.key === newKey);

  return (
    <Card className="mt-6 p-6">
      <h2 className="text-sm font-semibold text-neutral-900">{view.label}</h2>
      <p className="mt-1 text-sm text-neutral-500">{view.description}</p>
      {view.attrsHint ? (
        <p className="mt-1 text-xs text-neutral-400">Attributes: {view.attrsHint}</p>
      ) : null}

      <ul className="mt-4 divide-y divide-neutral-100">
        {view.entries.map((e) => (
          <li key={e.key} className="py-2">
            {edit?.key === e.key ? (
              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_5rem_1fr_auto_auto]">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-700">Label</span>
                  <input
                    className={inputCls}
                    value={edit.label}
                    maxLength={80}
                    onChange={(ev) => setEdit({ ...edit, label: ev.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-700">Order</span>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    value={edit.sortOrder}
                    onChange={(ev) => setEdit({ ...edit, sortOrder: ev.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-700">
                    Attributes (name=value, …)
                  </span>
                  <input
                    className={inputCls}
                    value={edit.attrs}
                    onChange={(ev) => setEdit({ ...edit, attrs: ev.target.value })}
                  />
                </label>
                <Button disabled={busy || !edit.label.trim()} onClick={() => save(e, edit)}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="w-10 text-right text-xs tabular-nums text-neutral-400">
                    {e.sortOrder}
                  </span>
                  <span
                    className={
                      e.isActive
                        ? "text-sm text-neutral-900"
                        : "text-sm text-neutral-400 line-through"
                    }
                  >
                    {e.label}
                  </span>
                  <code className="text-xs text-neutral-400">{e.key}</code>
                  <SourcePill e={e} />
                  {!e.isActive ? (
                    <span className="text-xs font-medium text-neutral-500">Off</span>
                  ) : null}
                  {Object.keys(e.attrs).length > 0 ? (
                    <span className="text-xs text-neutral-400">{attrsToText(e.attrs)}</span>
                  ) : null}
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 gap-3 text-sm">
                    <button
                      type="button"
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                      onClick={() =>
                        setEdit({
                          key: e.key,
                          label: e.label,
                          sortOrder: String(e.sortOrder),
                          attrs: attrsToText(e.attrs),
                          isActive: e.isActive,
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="font-medium text-neutral-600 hover:underline"
                      disabled={busy}
                      onClick={() => save(e, { isActive: !e.isActive })}
                    >
                      {e.isActive ? "Switch off" : "Switch on"}
                    </button>
                    {e.source === "override" ? (
                      <button
                        type="button"
                        className="font-medium text-neutral-600 hover:underline"
                        disabled={busy}
                        onClick={() => reset.mutate({ kind, key: e.key })}
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>

      {canEdit ? (
        <div className="mt-4 grid grid-cols-1 items-end gap-2 border-t border-neutral-100 pt-4 sm:grid-cols-[1fr_10rem_5rem_auto]">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700">Add a value</span>
            <input
              className={inputCls}
              value={draft.label}
              maxLength={80}
              placeholder="Label"
              onChange={(ev) => setDraft({ ...draft, label: ev.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700">Key</span>
            <input
              className={inputCls}
              value={draft.key}
              maxLength={40}
              placeholder={draft.label ? slugKey(draft.label) : "auto"}
              onChange={(ev) => setDraft({ ...draft, key: ev.target.value.toLowerCase() })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700">Order</span>
            <input
              type="number"
              min={0}
              className={inputCls}
              value={draft.sortOrder}
              onChange={(ev) => setDraft({ ...draft, sortOrder: ev.target.value })}
            />
          </label>
          <Button
            disabled={busy || !draft.label.trim() || !TENANT_LOOKUP_KEY_RE.test(newKey) || keyTaken}
            onClick={() =>
              upsert.mutate({
                kind,
                key: newKey,
                label: draft.label.trim(),
                sortOrder: Number(draft.sortOrder) || 100,
                isActive: true,
                attrs: {},
              })
            }
          >
            Add
          </Button>
          {keyTaken && draft.label.trim() ? (
            <p className="text-xs text-status-error-700 sm:col-span-4">
              The key “{newKey}” is already in this list. Edit that value instead, or pick another
              key.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function ListsClient({
  initial,
  canEdit,
}: {
  initial: ListTenantLookupsOutput;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const query = trpc.listTenantLookups.useQuery({}, { initialData: initial });
  const data = query.data ?? initial;
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSaved(text: string) {
    await Promise.all([
      utils.listTenantLookups.invalidate(),
      utils.getOrgAndJobArchitecture.invalidate(),
    ]);
    setNotice({ ok: true, text });
  }
  const onError = (err: unknown) => {
    setNotice({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    handleTRPCError(err, { onMessage: () => undefined });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Lists"
        subtitle="The values people pick from: employment and requisition types, hold, decline, renege and separation reasons, and asset types. Each list starts from the platform values; change, switch off or add your own."
      />
      {!canEdit ? (
        <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
          You can view these lists. Changes are made by an administrator.
        </div>
      ) : null}
      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.ok
              ? "border-status-success-200 bg-status-success-50 text-status-success-700"
              : "border-status-error-200 bg-status-error-50 text-status-error-700"
          }`}
        >
          {notice.text}
        </div>
      ) : null}
      {data.kinds.map((view) => (
        <KindCard
          key={view.kind}
          view={view}
          canEdit={canEdit}
          onSaved={onSaved}
          onError={onError}
        />
      ))}
    </PageContainer>
  );
}
