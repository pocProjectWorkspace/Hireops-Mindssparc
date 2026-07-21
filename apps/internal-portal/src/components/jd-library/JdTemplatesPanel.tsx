"use client";

import { useState } from "react";
import type {
  ListJdTemplatesOutput,
  JdTemplateRow,
  JdTemplateSkill,
  RequisitionLocationType,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Badge, Button, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";

/**
 * /jd-library → Templates (T12/G11). The org's curated JD-template library
 * (jd_templates): full CRUD for admin + hiring_manager. A template pre-fills the
 * requisition wizard's Basics + Skills steps and carries JD boilerplate + an
 * EEO/legal-clause block. Nothing here is authoritative — every field stays
 * editable after applying, and the clauses are curated, India-neutral starting
 * text that has NOT been legally reviewed (labelled below).
 *
 * Money: budgets are annual INR in MAJOR units (rupees) — the same unit the
 * wizard's comp-band fields use, NOT the paise convention.
 */

const LOCATION_TYPES: RequisitionLocationType[] = ["remote", "hybrid", "onsite", "multi"];
const inputCls = "rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm w-full";

function lpa(inr: number): string {
  const v = inr / 100_000;
  return `₹${v.toFixed(1).replace(/\.0$/, "")} LPA`;
}

interface FormState {
  label: string;
  title: string;
  roleFamily: string;
  seniority: string;
  locationType: RequisitionLocationType;
  budgetMinInr: string;
  budgetMaxInr: string;
  extraContext: string;
  bodyMd: string;
  legalClauses: string;
  sortOrder: string;
  skills: JdTemplateSkill[];
}

function emptyForm(): FormState {
  return {
    label: "",
    title: "",
    roleFamily: "",
    seniority: "",
    locationType: "hybrid",
    budgetMinInr: "",
    budgetMaxInr: "",
    extraContext: "",
    bodyMd: "",
    legalClauses: "",
    sortOrder: "0",
    skills: [],
  };
}

function formFromRow(r: JdTemplateRow): FormState {
  return {
    label: r.label,
    title: r.title,
    roleFamily: r.roleFamily,
    seniority: r.seniority,
    locationType: r.locationType,
    budgetMinInr: String(r.budgetMinInr),
    budgetMaxInr: String(r.budgetMaxInr),
    extraContext: r.extraContext,
    bodyMd: r.bodyMd,
    legalClauses: r.legalClauses,
    sortOrder: String(r.sortOrder),
    skills: r.skills,
  };
}

export function JdTemplatesPanel({ initial }: { initial: ListJdTemplatesOutput }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<JdTemplateRow | null>(null);
  const [creating, setCreating] = useState(false);

  const utils = trpc.useUtils();
  const query = trpc.listJdTemplates.useQuery(
    { includeArchived },
    { initialData: includeArchived ? undefined : initial, staleTime: 5_000 },
  );
  const archive = trpc.archiveJdTemplate.useMutation();

  const rows = query.data?.items ?? initial.items;

  function refresh() {
    void utils.listJdTemplates.invalidate();
  }

  async function onArchiveToggle(row: JdTemplateRow) {
    try {
      await archive.mutateAsync({ id: row.id, isArchived: !row.isArchived });
      refresh();
    } catch (err) {
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-neutral-600">
          Curated JD templates that pre-fill the requisition wizard&rsquo;s basics and skill
          weighting. Everything stays editable after applying. The legal-clause block is curated
          starting text that has <span className="font-medium">not been legally reviewed</span> —
          adapt it before publishing.
        </p>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          New template
        </Button>
      </div>

      <label className="mb-4 flex items-center gap-1.5 text-xs text-neutral-600">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(e) => setIncludeArchived(e.target.checked)}
        />
        Show archived
      </label>

      {rows.length === 0 ? (
        <EmptyState
          title="No templates yet"
          hint="Seed the defaults with pnpm db:seed:t12-jd-templates, or add your first template with “New template”."
        />
      ) : (
        <TableShell>
          <Thead>
            <Th>Label</Th>
            <Th>Title</Th>
            <Th>Family</Th>
            <Th>Seniority</Th>
            <Th>Location</Th>
            <Th numeric>Budget band</Th>
            <Th numeric>Skills</Th>
            <Th>{""}</Th>
          </Thead>
          <Tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="font-medium text-neutral-900">
                  {r.label}
                  {r.isArchived ? (
                    <Badge tone="warning" className="ml-2">
                      Archived
                    </Badge>
                  ) : null}
                </Td>
                <Td>{r.title}</Td>
                <Td>{r.roleFamily}</Td>
                <Td>{r.seniority}</Td>
                <Td className="capitalize">{r.locationType}</Td>
                <Td numeric>
                  {lpa(r.budgetMinInr)} – {lpa(r.budgetMaxInr)}
                </Td>
                <Td numeric>{r.skills.length}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onArchiveToggle(r)}
                      disabled={archive.isPending}
                    >
                      {r.isArchived ? "Restore" : "Archive"}
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      {creating ? (
        <TemplateEditor
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}
      {editing ? (
        <TemplateEditor
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function TemplateEditor({
  mode,
  row,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  row?: JdTemplateRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const create = trpc.createJdTemplate.useMutation();
  const update = trpc.updateJdTemplate.useMutation();
  const [f, setF] = useState<FormState>(row ? formFromRow(row) : emptyForm());
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setF((prev) => ({ ...prev, [key]: val }));
  }

  function updateSkill(i: number, patch: Partial<JdTemplateSkill>) {
    setF((prev) => ({
      ...prev,
      skills: prev.skills.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));
  }
  function addSkill() {
    setF((prev) => ({
      ...prev,
      skills: [
        ...prev.skills,
        { skillName: "", category: "General", weight: 5, isRequired: true, minYears: null },
      ],
    }));
  }
  function removeSkill(i: number) {
    setF((prev) => ({ ...prev, skills: prev.skills.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    setError(null);
    const min = Math.round(Number(f.budgetMinInr));
    const max = Math.round(Number(f.budgetMaxInr));
    if (f.label.trim().length === 0 || f.title.trim().length === 0) {
      setError("A label and title are required.");
      return;
    }
    if (f.roleFamily.trim().length === 0 || f.seniority.trim().length === 0) {
      setError("Role family and seniority are required.");
      return;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
      setError("Budget must be non-negative annual INR (major units).");
      return;
    }
    const skills = f.skills
      .filter((s) => s.skillName.trim().length > 0)
      .map((s) => ({
        skillName: s.skillName.trim(),
        category: s.category.trim() || "General",
        weight: Math.max(0, Math.min(10, Math.round(s.weight))),
        isRequired: s.isRequired,
        minYears: s.minYears == null ? null : Math.max(0, Math.round(s.minYears)),
      }));
    const payload = {
      label: f.label.trim(),
      title: f.title.trim(),
      roleFamily: f.roleFamily.trim(),
      seniority: f.seniority.trim(),
      locationType: f.locationType,
      budgetMinInr: min,
      budgetMaxInr: max,
      extraContext: f.extraContext,
      bodyMd: f.bodyMd,
      legalClauses: f.legalClauses,
      sortOrder: Math.max(0, Math.round(Number(f.sortOrder) || 0)),
      skills,
    };
    try {
      if (mode === "create") {
        await create.mutateAsync(payload);
      } else if (row) {
        await update.mutateAsync({ id: row.id, ...payload });
      }
      onSaved();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
      setError((prev) => prev ?? "Could not save the template. Please try again.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "create" ? "New template" : `Edit ${row?.label ?? "template"}`}
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-900">
            {mode === "create" ? "New JD template" : `Edit — ${row?.label}`}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Label text="Chip label (shown in the wizard)">
              <input
                className={inputCls}
                value={f.label}
                onChange={(e) => set("label", e.target.value)}
              />
            </Label>
            <Label text="Job title">
              <input
                className={inputCls}
                value={f.title}
                onChange={(e) => set("title", e.target.value)}
              />
            </Label>
            <Label text="Role family">
              <input
                className={inputCls}
                value={f.roleFamily}
                onChange={(e) => set("roleFamily", e.target.value)}
                placeholder="Engineering"
              />
            </Label>
            <Label text="Seniority">
              <input
                className={inputCls}
                value={f.seniority}
                onChange={(e) => set("seniority", e.target.value)}
                placeholder="Senior"
              />
            </Label>
            <Label text="Location type">
              <select
                className={inputCls}
                value={f.locationType}
                onChange={(e) => set("locationType", e.target.value as RequisitionLocationType)}
              >
                {LOCATION_TYPES.map((l) => (
                  <option key={l} value={l} className="capitalize">
                    {l}
                  </option>
                ))}
              </select>
            </Label>
            <Label text="Sort order">
              <input
                className={inputCls}
                inputMode="numeric"
                value={f.sortOrder}
                onChange={(e) => set("sortOrder", e.target.value)}
              />
            </Label>
            <Label text="Budget min (annual ₹, major units)">
              <input
                className={inputCls}
                inputMode="numeric"
                value={f.budgetMinInr}
                onChange={(e) => set("budgetMinInr", e.target.value)}
                placeholder="2800000"
              />
            </Label>
            <Label text="Budget max (annual ₹, major units)">
              <input
                className={inputCls}
                inputMode="numeric"
                value={f.budgetMaxInr}
                onChange={(e) => set("budgetMaxInr", e.target.value)}
                placeholder="4200000"
              />
            </Label>
          </div>

          <Label text="Extra context (steer prefilled into the JD generator)">
            <textarea
              className={`${inputCls} min-h-[64px]`}
              value={f.extraContext}
              onChange={(e) => set("extraContext", e.target.value)}
            />
          </Label>

          <Label text="JD boilerplate body (Markdown)">
            <textarea
              className={`${inputCls} min-h-[100px] font-mono text-xs`}
              value={f.bodyMd}
              onChange={(e) => set("bodyMd", e.target.value)}
            />
          </Label>

          <Label text="Legal / EEO clause block (curated — not legally reviewed)">
            <textarea
              className={`${inputCls} min-h-[80px] font-mono text-xs`}
              value={f.legalClauses}
              onChange={(e) => set("legalClauses", e.target.value)}
            />
          </Label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-700">Skill presets</span>
              <Button variant="ghost" size="sm" onClick={addSkill}>
                Add skill
              </Button>
            </div>
            {f.skills.length === 0 ? (
              <p className="text-xs text-neutral-400">
                No skills yet — applying this template will land an empty weighting table.
              </p>
            ) : (
              <div className="space-y-2">
                {f.skills.map((s, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-1 gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-12"
                  >
                    <input
                      className={`${inputCls} sm:col-span-4`}
                      placeholder="Skill name"
                      value={s.skillName}
                      onChange={(e) => updateSkill(i, { skillName: e.target.value })}
                    />
                    <input
                      className={`${inputCls} sm:col-span-3`}
                      placeholder="Category"
                      value={s.category}
                      onChange={(e) => updateSkill(i, { category: e.target.value })}
                    />
                    <input
                      className={`${inputCls} sm:col-span-2`}
                      inputMode="numeric"
                      placeholder="Weight"
                      value={String(s.weight)}
                      onChange={(e) => updateSkill(i, { weight: Number(e.target.value) || 0 })}
                    />
                    <input
                      className={`${inputCls} sm:col-span-2`}
                      inputMode="numeric"
                      placeholder="Min yrs"
                      value={s.minYears == null ? "" : String(s.minYears)}
                      onChange={(e) =>
                        updateSkill(i, {
                          minYears: e.target.value === "" ? null : Number(e.target.value) || 0,
                        })
                      }
                    />
                    <div className="flex items-center justify-between gap-2 sm:col-span-1">
                      <label className="flex items-center gap-1 text-[11px] text-neutral-600">
                        <input
                          type="checkbox"
                          checked={s.isRequired}
                          onChange={(e) => updateSkill(i, { isRequired: e.target.checked })}
                        />
                        Req
                      </label>
                      <button
                        type="button"
                        onClick={() => removeSkill(i)}
                        className="text-xs text-status-error-600 hover:underline"
                        aria-label="Remove skill"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error ? <p className="text-xs text-status-error-700">{error}</p> : null}
        </div>
        <div className="flex items-center gap-2 border-t border-neutral-100 px-6 py-4">
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create template" : "Save template"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-600">
      {text}
      {children}
    </label>
  );
}
