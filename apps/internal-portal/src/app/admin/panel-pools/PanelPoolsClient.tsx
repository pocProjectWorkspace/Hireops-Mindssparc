"use client";

import { useMemo, useState } from "react";
import type {
  PanelPoolRow,
  ListPanelPoolsOutput,
  ListTenantMembershipsOutput,
} from "@hireops/api-types";
import { Input, Button } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Panel pools editor (T3.3 / G16) — the interview-panel-pool library.
 *
 * REAL config: the owner plan-setup pool picker reads the managed, non-archived
 * list, and picking a pool on an interview-plan round COPIES the pool's members
 * into the round's default panel (which INT-02 seeds interview_panelists from).
 * The round keeps panel_pool_id as provenance, so a manual override reads as a
 * divergence. Archiving retires a pool from the picker WITHOUT breaking rounds
 * already on it.
 */

export function PanelPoolsClient({
  initial,
  memberships,
}: {
  initial: ListPanelPoolsOutput;
  memberships: ListTenantMembershipsOutput;
}) {
  const utils = trpc.useUtils();
  const query = trpc.listPanelPools.useQuery({ includeArchived: true }, { initialData: initial });
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);

  const memberOptions = useMemo(
    () =>
      (memberships.items ?? []).map((m) => ({
        id: m.membershipId,
        label: m.displayName ?? m.email ?? m.membershipId.slice(0, 8),
      })),
    [memberships],
  );
  const memberLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of memberOptions) map.set(m.id, m.label);
    return map;
  }, [memberOptions]);

  const [notice, setNotice] = useState<string | null>(null);

  // Create form.
  const [draftName, setDraftName] = useState("");
  const [draftFocus, setDraftFocus] = useState("");

  // Per-row rename editor.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editFocus, setEditFocus] = useState("");

  // Per-row member editor.
  const [membersEditingId, setMembersEditingId] = useState<string | null>(null);
  const [memberDraft, setMemberDraft] = useState<string[]>([]);

  async function refetch() {
    await utils.listPanelPools.invalidate();
  }

  const create = trpc.createPanelPool.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Created “${res.row.name}”.`);
      setDraftName("");
      setDraftFocus("");
    },
    onError: (err) => {
      setNotice(`Create failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const rename = trpc.renamePanelPool.useMutation({
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

  const setMembers = trpc.setPanelPoolMembers.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`Saved ${res.row.memberMembershipIds.length} member(s) for “${res.row.name}”.`);
      setMembersEditingId(null);
    },
    onError: (err) => {
      setNotice(`Update failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const setArchived = trpc.setPanelPoolArchived.useMutation({
    onSuccess: async (res) => {
      await refetch();
      setNotice(`“${res.row.name}” is now ${res.row.isArchived ? "archived" : "active"}.`);
    },
    onError: (err) => {
      setNotice(`Update failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const busy =
    create.isPending || rename.isPending || setMembers.isPending || setArchived.isPending;

  function startEdit(row: PanelPoolRow) {
    setEditingId(row.id);
    setEditName(row.name);
    setEditFocus(row.focus ?? "");
    setMembersEditingId(null);
    setNotice(null);
  }
  function startEditMembers(row: PanelPoolRow) {
    setMembersEditingId(row.id);
    setMemberDraft(row.memberMembershipIds);
    setEditingId(null);
    setNotice(null);
  }
  function toggleMember(id: string) {
    setMemberDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Panel pools"
        subtitle="Manage this tenant's interview-panel pools. The plan-setup pool picker reads this list — picking a pool on a round copies its members into the round's default panel, which INT-02 seeds the real panel from."
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
        Picking a pool on an interview-plan round copies the pool&apos;s members into that
        round&apos;s default panel — the same list that seeds the real interview panelists. The
        panel stays editable on the round: an edit is kept as an override, with the pool retained as
        provenance. Archiving a pool hides it from the picker but leaves rounds already on it valid.
      </div>

      {/* Create panel */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Add a panel pool</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            maxLength={120}
            required
            placeholder="Backend loop"
          />
          <Input
            label="Focus (optional)"
            value={draftFocus}
            onChange={(e) => setDraftFocus(e.target.value)}
            maxLength={200}
            placeholder="System design + ownership"
          />
        </div>
        <div className="mt-6">
          <Button
            onClick={() =>
              create.mutate({
                name: draftName.trim(),
                focus: draftFocus.trim() ? draftFocus.trim() : undefined,
              })
            }
            disabled={draftName.trim().length === 0 || busy}
          >
            {create.isPending ? "Adding…" : "Add pool"}
          </Button>
          <span className="ml-3 text-xs text-neutral-500">
            Add members after creating the pool.
          </span>
        </div>
      </Card>

      {/* Pool list */}
      <Card className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-neutral-800">No panel pools yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              Add a pool above to start building this tenant&apos;s panel-pool library.
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
                      {row.focus ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
                          {row.focus}
                        </span>
                      ) : null}
                      {row.isArchived ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-500">
                          Archived
                        </span>
                      ) : null}
                    </div>
                    <span className="mt-0.5 block text-xs text-neutral-500">
                      {row.memberMembershipIds.length === 0
                        ? "No members yet"
                        : `${row.memberMembershipIds.length} member${
                            row.memberMembershipIds.length === 1 ? "" : "s"
                          }: ${row.memberMembershipIds
                            .map((id) => memberLabel.get(id) ?? id.slice(0, 8))
                            .join(", ")}`}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => startEditMembers(row)}
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                    >
                      Members
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                    >
                      Rename
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
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={120}
                    />
                    <Input
                      label="Focus (optional)"
                      value={editFocus}
                      onChange={(e) => setEditFocus(e.target.value)}
                      maxLength={200}
                    />
                    <div className="flex items-end gap-3 sm:col-span-2">
                      <Button
                        onClick={() =>
                          rename.mutate({
                            id: row.id,
                            name: editName.trim(),
                            focus: editFocus.trim() ? editFocus.trim() : null,
                          })
                        }
                        disabled={editName.trim().length === 0 || busy}
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

                {membersEditingId === row.id ? (
                  <div className="mt-3">
                    <p className="mb-1 text-sm font-medium text-neutral-700">Pool members</p>
                    {memberOptions.length === 0 ? (
                      <p className="text-xs text-neutral-500">No memberships available.</p>
                    ) : (
                      <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-neutral-200 p-2">
                        {memberOptions.map((m) => (
                          <label
                            key={m.id}
                            className="flex items-center gap-1.5 text-sm text-neutral-700"
                          >
                            <input
                              type="checkbox"
                              checked={memberDraft.includes(m.id)}
                              onChange={() => toggleMember(m.id)}
                            />
                            {m.label}
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <Button
                        onClick={() =>
                          setMembers.mutate({ id: row.id, membershipIds: memberDraft })
                        }
                        disabled={busy}
                      >
                        {setMembers.isPending ? "Saving…" : "Save members"}
                      </Button>
                      <button
                        type="button"
                        className="text-sm text-neutral-600 hover:underline"
                        onClick={() => setMembersEditingId(null)}
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
