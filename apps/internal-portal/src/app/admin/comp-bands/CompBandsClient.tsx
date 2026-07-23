"use client";

import { useMemo, useState } from "react";
import type { CompBandRow, ListCompBandsOutput } from "@hireops/api-types";
import { Input, Button } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Comp bands editor (T3.2 / G15) — the compensation-band library.
 *
 * REAL config: the requisition wizard's comp-band picker reads the managed,
 * non-archived list, and picking a band POPULATES the position's comp
 * min/max/currency (which the deterministic comp-rules verdict engine +
 * feasibility/detail views already read). The position keeps comp_band_id as
 * provenance, so an edit to the filled values reads as a divergence. Archiving
 * retires a band from the picker WITHOUT breaking positions already on it.
 */

interface DraftForm {
  name: string;
  level: string;
  currency: string;
  minMajor: string;
  maxMajor: string;
}

const EMPTY_DRAFT: DraftForm = {
  name: "",
  level: "",
  currency: "INR",
  minMajor: "",
  maxMajor: "",
};

function fmtMajor(currency: string, value: number): string {
  return `${currency} ${value.toLocaleString("en-IN")}`;
}

function draftValid(d: DraftForm): boolean {
  const name = d.name.trim();
  const min = Number(d.minMajor);
  const max = Number(d.maxMajor);
  return (
    name.length >= 1 &&
    name.length <= 120 &&
    d.currency.trim().length === 3 &&
    d.minMajor.trim().length > 0 &&
    d.maxMajor.trim().length > 0 &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min >= 0 &&
    max >= 0 &&
    min <= max
  );
}

export function CompBandsClient({ initial }: { initial: ListCompBandsOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.listCompBands.useQuery({ includeArchived: true }, { initialData: initial });
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);

  const [notice, setNotice] = useState<string | null>(null);

  // Create form.
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);

  // Per-row inline editor.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<DraftForm>(EMPTY_DRAFT);

  async function refetch() {
    await utils.listCompBands.invalidate();
  }

  const create = trpc.createCompBand.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Created “${res.row.name}”.`);
      setDraft(EMPTY_DRAFT);
    },
    onError: (err) => {
      setNotice(`Create failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const update = trpc.updateCompBand.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Updated “${res.row.name}”.`);
      setEditingId(null);
    },
    onError: (err) => {
      setNotice(`Update failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const setArchived = trpc.setCompBandArchived.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`“${res.row.name}” is now ${res.row.isArchived ? "archived" : "active"}.`);
    },
    onError: (err) => {
      setNotice(`Update failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const busy = create.isPending || update.isPending || setArchived.isPending;

  function startEdit(row: CompBandRow) {
    setEditingId(row.id);
    setEditForm({
      name: row.name,
      level: row.level ?? "",
      currency: row.currency,
      minMajor: String(row.minMajor),
      maxMajor: String(row.maxMajor),
    });
    setNotice(null);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Comp bands"
        subtitle="Manage this tenant's compensation-band library. The requisition wizard's picker reads this list — picking a band populates the position's comp min/max, which the comp verdict engine reads."
      />

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.includes("failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      {/* Honesty banner. */}
      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        Picking a band in the requisition wizard populates the position&apos;s comp
        min/max/currency, which the deterministic comp-rules verdict engine and the feasibility view
        read. The values stay editable — an edit is kept as an override, with the band retained as
        provenance. Archiving a band hides it from the picker but leaves positions already on it
        valid.
      </div>

      {/* Create panel */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Add a comp band</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={120}
            required
            placeholder="Senior Backend — Bengaluru"
          />
          <Input
            label="Level (optional)"
            value={draft.level}
            onChange={(e) => setDraft({ ...draft, level: e.target.value })}
            maxLength={80}
            placeholder="P4"
          />
          <Input
            label="Currency"
            value={draft.currency}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
            maxLength={3}
            required
            placeholder="INR"
          />
          <div />
          <Input
            type="number"
            label="Min (per year)"
            value={draft.minMajor}
            onChange={(e) => setDraft({ ...draft, minMajor: e.target.value })}
            min={0}
            required
            placeholder="2800000"
          />
          <Input
            type="number"
            label="Max (per year)"
            value={draft.maxMajor}
            onChange={(e) => setDraft({ ...draft, maxMajor: e.target.value })}
            min={0}
            required
            placeholder="4200000"
          />
        </div>
        <div className="mt-6">
          <Button
            onClick={() =>
              create.mutate({
                name: draft.name.trim(),
                level: draft.level.trim() ? draft.level.trim() : undefined,
                currency: draft.currency.trim().toUpperCase(),
                minMajor: Number(draft.minMajor),
                maxMajor: Number(draft.maxMajor),
              })
            }
            disabled={!draftValid(draft) || busy}
          >
            {create.isPending ? "Adding…" : "Add band"}
          </Button>
        </div>
      </Card>

      {/* Band list */}
      <Card className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-neutral-800">No comp bands yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              Add a band above to start building this tenant&apos;s comp-band library.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-medium ${
                          row.isArchived ? "text-neutral-400 line-through" : "text-neutral-900"
                        }`}
                      >
                        {row.name}
                      </span>
                      {row.level ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
                          {row.level}
                        </span>
                      ) : null}
                      {row.isArchived ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-500">
                          Archived
                        </span>
                      ) : null}
                    </div>
                    <span className="mt-0.5 block text-xs text-neutral-500">
                      {fmtMajor(row.currency, row.minMajor)} –{" "}
                      {fmtMajor(row.currency, row.maxMajor)} / yr
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setArchived.mutate({ id: row.id, archived: !row.isArchived })}
                      className="font-medium text-neutral-600 hover:underline"
                      disabled={busy}
                    >
                      {row.isArchived ? "Unarchive" : "Archive"}
                    </button>
                  </div>
                </div>

                {editingId === row.id ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Input
                      label="Name"
                      value={editForm.name}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      maxLength={120}
                    />
                    <Input
                      label="Level (optional)"
                      value={editForm.level}
                      onChange={(e) => setEditForm({ ...editForm, level: e.target.value })}
                      maxLength={80}
                    />
                    <Input
                      label="Currency"
                      value={editForm.currency}
                      onChange={(e) =>
                        setEditForm({ ...editForm, currency: e.target.value.toUpperCase() })
                      }
                      maxLength={3}
                    />
                    <div />
                    <Input
                      type="number"
                      label="Min (per year)"
                      value={editForm.minMajor}
                      onChange={(e) => setEditForm({ ...editForm, minMajor: e.target.value })}
                      min={0}
                    />
                    <Input
                      type="number"
                      label="Max (per year)"
                      value={editForm.maxMajor}
                      onChange={(e) => setEditForm({ ...editForm, maxMajor: e.target.value })}
                      min={0}
                    />
                    <div className="flex items-end gap-3 sm:col-span-2">
                      <Button
                        onClick={() =>
                          update.mutate({
                            id: row.id,
                            name: editForm.name.trim(),
                            level: editForm.level.trim() ? editForm.level.trim() : undefined,
                            currency: editForm.currency.trim().toUpperCase(),
                            minMajor: Number(editForm.minMajor),
                            maxMajor: Number(editForm.maxMajor),
                          })
                        }
                        disabled={!draftValid(editForm) || busy}
                      >
                        Save
                      </Button>
                      <button
                        type="button"
                        className="pb-2 text-sm text-neutral-600 hover:underline"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
