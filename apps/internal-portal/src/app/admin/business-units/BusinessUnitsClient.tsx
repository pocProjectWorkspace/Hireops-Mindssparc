"use client";

import { useMemo, useState } from "react";
import type { BusinessUnitRow, ListBusinessUnitsOutput } from "@hireops/api-types";
import { Input, Select, Button } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Business units editor (T3.1 / G14) — the org-structure management surface.
 *
 * The hierarchy is REAL config: the requisition wizard's picker reads the
 * managed, non-archived list, so what an admin creates / renames / archives here
 * genuinely drives requisition creation. A rename touches the display NAME only
 * (the slug is immutable — positions FK by id and the department-name join
 * reflects the rename live). Reparenting is cycle-guarded server-side. Archiving
 * retires a unit from the picker WITHOUT breaking positions already attached to it.
 */

interface TreeNode {
  row: BusinessUnitRow;
  depth: number;
}

/** Flatten the flat rows into a depth-ordered list (children under parents). */
function buildTree(rows: BusinessUnitRow[]): TreeNode[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, BusinessUnitRow[]>();
  for (const r of rows) {
    // A row whose parent isn't in the set (or is null) is a root.
    const parentKey =
      r.parentBusinessUnitId && byId.has(r.parentBusinessUnitId) ? r.parentBusinessUnitId : null;
    const bucket = childrenOf.get(parentKey) ?? [];
    bucket.push(r);
    childrenOf.set(parentKey, bucket);
  }
  const out: TreeNode[] = [];
  const walk = (parentKey: string | null, depth: number) => {
    const kids = (childrenOf.get(parentKey) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const row of kids) {
      out.push({ row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function BusinessUnitsClient({ initial }: { initial: ListBusinessUnitsOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.listBusinessUnits.useQuery(
    { includeArchived: true },
    { initialData: initial },
  );
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const tree = useMemo(() => buildTree(rows), [rows]);

  const [notice, setNotice] = useState<string | null>(null);

  // Create form.
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState<string>("");

  // Per-row inline editors.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [reparentingId, setReparentingId] = useState<string | null>(null);
  const [reparentValue, setReparentValue] = useState<string>("");

  // Active units are the valid parent choices (you don't nest under an archived
  // unit). "Top level" is the empty option.
  const activeUnits = useMemo(() => rows.filter((r) => !r.isArchived), [rows]);

  async function refetch() {
    await utils.listBusinessUnits.invalidate();
  }

  const create = trpc.createBusinessUnit.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Created “${res.row.name}”.`);
      setNewName("");
      setNewParent("");
    },
    onError: (err) => {
      setNotice(`Create failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const rename = trpc.renameBusinessUnit.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Renamed to “${res.row.name}”.`);
      setRenamingId(null);
    },
    onError: (err) => {
      setNotice(`Rename failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const reparent = trpc.reparentBusinessUnit.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Moved “${res.row.name}”.`);
      setReparentingId(null);
    },
    onError: (err) => {
      setNotice(`Move failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const setArchived = trpc.setBusinessUnitArchived.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`“${res.row.name}” is now ${res.row.isArchived ? "archived" : "active"}.`);
    },
    onError: (err) => {
      setNotice(`Update failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const newNameValid = newName.trim().length >= 1 && newName.trim().length <= 120;
  const busy = create.isPending || rename.isPending || reparent.isPending || setArchived.isPending;

  function parentOptions(excludeId?: string) {
    return [
      { value: "", label: "— Top level —" },
      ...activeUnits.filter((u) => u.id !== excludeId).map((u) => ({ value: u.id, label: u.name })),
    ];
  }

  function startRename(row: BusinessUnitRow) {
    setReparentingId(null);
    setRenamingId(row.id);
    setRenameValue(row.name);
    setNotice(null);
  }

  function startReparent(row: BusinessUnitRow) {
    setRenamingId(null);
    setReparentingId(row.id);
    setReparentValue(row.parentBusinessUnitId ?? "");
    setNotice(null);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Business units"
        subtitle="Manage this tenant's org hierarchy. The requisition wizard's picker reads this list — so what you define here drives requisition creation."
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
        Renaming a unit changes its display name only — its identity is stable, so requisitions and
        positions already attached keep working and reflect the new name. Archiving a unit hides it
        from the requisition picker but leaves existing requisitions on it valid.
      </div>

      {/* Create panel */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Add a business unit</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={120}
            required
            placeholder="GCC — Bengaluru"
          />
          <div>
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              Parent (optional)
            </span>
            <Select
              options={parentOptions()}
              value={newParent}
              onValueChange={setNewParent}
              placeholder="— Top level —"
            />
          </div>
        </div>
        <div className="mt-6">
          <Button
            onClick={() =>
              create.mutate({
                name: newName.trim(),
                parentBusinessUnitId: newParent === "" ? null : newParent,
              })
            }
            disabled={!newNameValid || busy}
          >
            {create.isPending ? "Adding…" : "Add unit"}
          </Button>
        </div>
      </Card>

      {/* Hierarchy tree */}
      <Card className="mt-6 overflow-hidden p-0">
        {tree.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-neutral-800">No business units yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              Add a unit above to start defining this tenant&apos;s org structure.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {tree.map(({ row, depth }) => (
              <li key={row.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1" style={{ paddingLeft: `${depth * 20}px` }}>
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-medium ${
                          row.isArchived ? "text-neutral-400 line-through" : "text-neutral-900"
                        }`}
                      >
                        {row.name}
                      </span>
                      {row.isArchived ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-500">
                          Archived
                        </span>
                      ) : null}
                    </div>
                    <code className="mt-0.5 block text-xs text-neutral-400">{row.slug}</code>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => startRename(row)}
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => startReparent(row)}
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                    >
                      Move
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

                {renamingId === row.id ? (
                  <div
                    className="mt-3 flex items-end gap-3"
                    style={{ paddingLeft: `${depth * 20}px` }}
                  >
                    <div className="flex-1">
                      <Input
                        label="New name"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={120}
                      />
                    </div>
                    <Button
                      onClick={() => rename.mutate({ id: row.id, name: renameValue.trim() })}
                      disabled={renameValue.trim().length < 1 || busy}
                    >
                      Save
                    </Button>
                    <button
                      type="button"
                      className="pb-2 text-sm text-neutral-600 hover:underline"
                      onClick={() => setRenamingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}

                {reparentingId === row.id ? (
                  <div
                    className="mt-3 flex items-end gap-3"
                    style={{ paddingLeft: `${depth * 20}px` }}
                  >
                    <div className="flex-1">
                      <span className="mb-1 block text-sm font-medium text-neutral-700">
                        New parent
                      </span>
                      <Select
                        options={parentOptions(row.id)}
                        value={reparentValue}
                        onValueChange={setReparentValue}
                        placeholder="— Top level —"
                      />
                    </div>
                    <Button
                      onClick={() =>
                        reparent.mutate({
                          id: row.id,
                          parentBusinessUnitId: reparentValue === "" ? null : reparentValue,
                        })
                      }
                      disabled={busy}
                    >
                      Move
                    </Button>
                    <button
                      type="button"
                      className="pb-2 text-sm text-neutral-600 hover:underline"
                      onClick={() => setReparentingId(null)}
                    >
                      Cancel
                    </button>
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
