"use client";

import { useMemo, useState } from "react";
import {
  APPLICABILITY_ATTRIBUTES,
  APPLICABILITY_ATTRIBUTE_LABELS,
  TEMPLATE_KINDS,
  TEMPLATE_KIND_META,
  type ApplicabilityAttribute,
  type ApplicabilityConditions,
  type GetOrgAndJobArchitectureOutput,
  type ListTemplateAssignmentsOutput,
  type PreviewResolvedConfigurationOutput,
  type TemplateAssignmentRow,
  type TemplateKind,
} from "@hireops/api-types";
import { Badge, Button, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Applicability (C2-F12 — Plan A §15 P3).
 *
 * Per template kind: the rules ("assignments") that say which template a
 * requisition gets. A rule is an AND of conditions over the requisition's org
 * and job attributes; a rule with no conditions is the kind's default. The
 * most specific matching rule wins, then the higher priority, then the newest.
 * No match keeps today's tenant default (shown as the fallback).
 *
 * "Test against a requisition" runs previewResolvedConfiguration for a real
 * requisition or a what-if attribute set and shows the winner per kind and why.
 * hr_head sees the page read-only; writes are admin-only server-side too.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-50";
const labelCls = "mb-1 block text-xs font-medium text-neutral-700";

type InAttribute = Exclude<ApplicabilityAttribute, "job_level_rank">;

interface Option {
  value: string;
  label: string;
}

interface RuleForm {
  name: string;
  templateId: string;
  priority: string;
  isActive: boolean;
  /** Attributes the rule tests (checked in the builder). */
  enabled: Partial<Record<ApplicabilityAttribute, boolean>>;
  values: Partial<Record<InAttribute, string[]>>;
  rankMin: string;
  rankMax: string;
}

const EMPTY_FORM: RuleForm = {
  name: "",
  templateId: "",
  priority: "0",
  isActive: true,
  enabled: {},
  values: {},
  rankMin: "",
  rankMax: "",
};

function formFromRow(r: TemplateAssignmentRow): RuleForm {
  const c = r.conditions;
  const enabled: RuleForm["enabled"] = {};
  const values: RuleForm["values"] = {};
  for (const a of APPLICABILITY_ATTRIBUTES) {
    if (c[a] === undefined) continue;
    enabled[a] = true;
    if (a !== "job_level_rank") values[a] = [...((c[a] as { in: string[] }).in ?? [])];
  }
  return {
    name: r.name,
    templateId: r.templateId,
    priority: String(r.priority),
    isActive: r.isActive,
    enabled,
    values,
    rankMin: c.job_level_rank?.min != null ? String(c.job_level_rank.min) : "",
    rankMax: c.job_level_rank?.max != null ? String(c.job_level_rank.max) : "",
  };
}

/** Builder state → conditions (an enabled attribute with no values is an error). */
function conditionsFromForm(
  f: RuleForm,
): { ok: true; value: ApplicabilityConditions } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const a of APPLICABILITY_ATTRIBUTES) {
    if (!f.enabled[a]) continue;
    if (a === "job_level_rank") {
      const min = f.rankMin.trim() === "" ? null : Number(f.rankMin);
      const max = f.rankMax.trim() === "" ? null : Number(f.rankMax);
      if (min === null && max === null) {
        return { ok: false, error: "Pick a lowest level, a highest level or both." };
      }
      if (min !== null && max !== null && min > max) {
        return { ok: false, error: "The lowest level must not rank above the highest level." };
      }
      out[a] = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
      continue;
    }
    const vals = (f.values[a] ?? []).map((v) => v.trim()).filter(Boolean);
    if (vals.length === 0) {
      return {
        ok: false,
        error: `Pick at least one value for “${APPLICABILITY_ATTRIBUTE_LABELS[a]}”.`,
      };
    }
    out[a] = { in: [...new Set(vals)] };
  }
  return { ok: true, value: out as ApplicabilityConditions };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

/** A compact checkbox list (the multi-value picker for an `in` predicate). */
function MultiPick({
  options,
  selected,
  onChange,
  disabled,
}: {
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) {
    return <p className="text-xs text-neutral-500">Nothing to pick from yet.</p>;
  }
  return (
    <div className="max-h-36 overflow-y-auto rounded-button border border-neutral-200 bg-white p-2">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 py-0.5 text-sm text-neutral-800">
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.includes(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value),
              )
            }
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export function ApplicabilityClient({
  initial,
  architecture,
  canEdit,
}: {
  initial: ListTemplateAssignmentsOutput;
  architecture: GetOrgAndJobArchitectureOutput;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const query = trpc.listTemplateAssignments.useQuery({}, { initialData: initial });
  const data = query.data ?? initial;
  const arch = architecture;

  const [kind, setKind] = useState<TemplateKind>("interview_loop");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);

  // ── picker options (org + job architecture + lookups) ──
  const opts = useMemo(() => {
    const countries = new Set<string>();
    for (const e of arch.legalEntities) countries.add(e.countryCode.toUpperCase());
    for (const l of arch.locations) countries.add(l.countryCode.toUpperCase());
    const buById = new Map(arch.businessUnits.map((b) => [b.id, b] as const));
    const buPath = (id: string): string => {
      const names: string[] = [];
      const seen = new Set<string>();
      let cur: string | null = id;
      while (cur && !seen.has(cur) && names.length < 16) {
        seen.add(cur);
        const b = buById.get(cur);
        if (!b) break;
        names.unshift(b.name);
        cur = b.parentBusinessUnitId;
      }
      return names.join(" › ");
    };
    const inactive = (on: boolean) => (on ? "" : " (inactive)");
    const byAttr: Record<InAttribute, Option[]> = {
      legal_entity_id: arch.legalEntities.map((e) => ({
        value: e.id,
        label: `${e.name} (${e.countryCode})${inactive(e.isActive)}`,
      })),
      country_code: [...countries].sort().map((c) => ({ value: c, label: c })),
      business_unit_id: arch.businessUnits
        .map((b) => ({ value: b.id, label: `${buPath(b.id)}${b.isArchived ? " (archived)" : ""}` }))
        .sort((x, y) => x.label.localeCompare(y.label)),
      location_id: arch.locations.map((l) => ({
        value: l.id,
        label: `${l.name}${l.city ? `, ${l.city}` : ""}${inactive(l.isActive)}`,
      })),
      job_function_id: arch.jobFunctions.map((f) => ({
        value: f.id,
        label: `${f.label}${inactive(f.isActive)}`,
      })),
      job_profile_id: arch.jobProfiles.map((p) => ({
        value: p.id,
        label: `${p.title}${inactive(p.isActive)}`,
      })),
      employment_type_key: arch.lookups.employmentType.map((l) => ({
        value: l.key,
        label: l.label,
      })),
      requisition_type_key: arch.lookups.requisitionType.map((l) => ({
        value: l.key,
        label: l.label,
      })),
    };
    const labelOf = new Map<string, string>();
    for (const list of Object.values(byAttr)) for (const o of list) labelOf.set(o.value, o.label);
    return { byAttr, labelOf };
  }, [arch]);

  const levelByRank = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of arch.jobLevels) if (!m.has(l.rank)) m.set(l.rank, `${l.label} (${l.key})`);
    return m;
  }, [arch.jobLevels]);

  function describeConditions(c: ApplicabilityConditions): string {
    const parts: string[] = [];
    for (const a of APPLICABILITY_ATTRIBUTES) {
      if (c[a] === undefined) continue;
      if (a === "job_level_rank") {
        const r = c.job_level_rank;
        if (!r) continue;
        const lo = r.min != null ? (levelByRank.get(r.min) ?? `rank ${r.min}`) : null;
        const hi = r.max != null ? (levelByRank.get(r.max) ?? `rank ${r.max}`) : null;
        parts.push(
          `Level ${lo && hi ? `${lo} – ${hi}` : lo ? `${lo} and above` : `up to ${hi ?? "?"}`}`,
        );
        continue;
      }
      const vals = ((c[a] as { in: string[] }).in ?? []).map((v) => opts.labelOf.get(v) ?? v);
      parts.push(`${APPLICABILITY_ATTRIBUTE_LABELS[a]}: ${vals.join(", ")}`);
    }
    return parts.length ? parts.join(" AND ") : "Every requisition (default)";
  }

  const rows = data.assignments.filter((a) => a.templateKind === kind);
  const targets = data.targets.filter((t) => t.kind === kind);
  const meta = TEMPLATE_KIND_META[kind];

  async function refresh(text: string) {
    await utils.listTemplateAssignments.invalidate();
    setNotice({ ok: true, text });
  }
  const onError = (err: unknown) => {
    setNotice({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    handleTRPCError(err, { onMessage: () => undefined });
  };

  const createRule = trpc.createTemplateAssignment.useMutation({
    onSuccess: async (r) => {
      setEditingId(null);
      await refresh(`Added rule “${r.row.name}”.`);
    },
    onError,
  });
  const updateRule = trpc.updateTemplateAssignment.useMutation({
    onSuccess: async (r) => {
      setEditingId(null);
      await refresh(`Saved rule “${r.row.name}”.`);
    },
    onError,
  });
  const deleteRule = trpc.deleteTemplateAssignment.useMutation({
    onSuccess: async () => refresh("Rule removed."),
    onError,
  });
  const busy = createRule.isPending || updateRule.isPending || deleteRule.isPending;

  function save() {
    setNotice(null);
    const c = conditionsFromForm(form);
    if (!c.ok) {
      setNotice({ ok: false, text: c.error });
      return;
    }
    const priority = Number(form.priority) || 0;
    if (editingId === "new") {
      createRule.mutate({
        templateKind: kind,
        name: form.name.trim(),
        templateId: form.templateId,
        priority,
        isActive: form.isActive,
        conditions: c.value,
      });
    } else if (editingId) {
      updateRule.mutate({
        id: editingId,
        name: form.name.trim(),
        templateId: form.templateId,
        priority,
        isActive: form.isActive,
        conditions: c.value,
      });
    }
  }

  function editor() {
    const set = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }));
    return (
      <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50/30 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Rule name">
            <input
              className={inputCls}
              value={form.name}
              maxLength={120}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label={meta.label}>
            <select
              className={inputCls}
              value={form.templateId}
              onChange={(e) => set({ templateId: e.target.value })}
            >
              <option value="">— Pick one —</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority (higher wins a tie)">
            <input
              type="number"
              min={-1000}
              max={1000}
              className={inputCls}
              value={form.priority}
              onChange={(e) => set({ priority: e.target.value })}
            />
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => set({ isActive: e.target.checked })}
            />
            Active
          </label>
        </div>

        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Conditions (all must hold; none = the default for this kind)
        </h3>
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {APPLICABILITY_ATTRIBUTES.map((a) => (
            <div key={a} className="rounded-lg border border-neutral-200 bg-white p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
                <input
                  type="checkbox"
                  checked={Boolean(form.enabled[a])}
                  onChange={(e) => set({ enabled: { ...form.enabled, [a]: e.target.checked } })}
                />
                {APPLICABILITY_ATTRIBUTE_LABELS[a]}
              </label>
              {form.enabled[a] ? (
                <div className="mt-2">
                  {a === "job_level_rank" ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Lowest level">
                        <select
                          className={inputCls}
                          value={form.rankMin}
                          onChange={(e) => set({ rankMin: e.target.value })}
                        >
                          <option value="">— Any —</option>
                          {arch.jobLevels.map((l) => (
                            <option key={l.id} value={String(l.rank)}>
                              {l.label} ({l.key})
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Highest level">
                        <select
                          className={inputCls}
                          value={form.rankMax}
                          onChange={(e) => set({ rankMax: e.target.value })}
                        >
                          <option value="">— Any —</option>
                          {arch.jobLevels.map((l) => (
                            <option key={l.id} value={String(l.rank)}>
                              {l.label} ({l.key})
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  ) : (
                    <MultiPick
                      options={opts.byAttr[a]}
                      selected={form.values[a] ?? []}
                      onChange={(next) => set({ values: { ...form.values, [a]: next } })}
                    />
                  )}
                  {a === "business_unit_id" ? (
                    <p className="mt-1 text-xs text-neutral-500">Also matches every sub-unit.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <Button disabled={busy || !form.name.trim() || !form.templateId} onClick={save}>
            {editingId === "new" ? "Add rule" : "Save rule"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setEditingId(null)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Applicability"
        subtitle="Which template applies to which requisition. The most specific matching rule wins, then the higher priority, then the newest. When no rule matches, today's default applies."
      />

      {!canEdit ? (
        <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
          You can view the rules and test them. Changes are made by an administrator.
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

      <div className="mt-6 flex flex-wrap gap-2" role="tablist">
        {TEMPLATE_KINDS.map((k) => {
          const m = TEMPLATE_KIND_META[k];
          const count = data.assignments.filter((a) => a.templateKind === k).length;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === kind}
              onClick={() => {
                setKind(k);
                setEditingId(null);
              }}
              className={`rounded-full border px-3 py-1 text-sm ${
                k === kind
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
              } ${m.consumed ? "" : "opacity-60"}`}
            >
              {m.label}
              {count ? ` · ${count}` : ""}
              {m.consumed ? "" : " (reserved)"}
            </button>
          );
        })}
      </div>

      <Card className="mt-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">{meta.label} rules</h2>
            <p className="mt-1 text-sm text-neutral-500">{meta.description}</p>
            <p className="mt-1 text-xs text-neutral-500">No match: {meta.fallback}</p>
          </div>
          {canEdit && meta.consumed && editingId === null ? (
            <Button
              size="sm"
              onClick={() => {
                setNotice(null);
                setForm(EMPTY_FORM);
                setEditingId("new");
              }}
            >
              Add rule
            </Button>
          ) : null}
        </div>

        {!meta.consumed ? (
          <p className="mt-4 text-sm text-neutral-500">
            Nothing reads this kind yet, so it can&apos;t be assigned. It is listed so the rules are
            ready when that feature lands.
          </p>
        ) : null}

        {editingId === "new" ? editor() : null}

        {rows.length === 0 && meta.consumed ? (
          <p className="mt-4 text-sm text-neutral-500">
            No rules yet. Every requisition gets the fallback above.
          </p>
        ) : null}

        <div className="mt-4 space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-900">{r.name}</span>
                    <span className="text-sm text-neutral-600">
                      → {r.templateLabel ?? "(missing)"}
                    </span>
                    {r.isActive ? null : <Badge tone="neutral">Inactive</Badge>}
                    <Badge tone="info">Priority {r.priority}</Badge>
                    {r.templateProblem ? <Badge tone="warning">{r.templateProblem}</Badge> : null}
                    {r.conditionsMalformed ? (
                      <Badge tone="error">Conditions unreadable — matches nothing</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-neutral-600">
                    {describeConditions(r.conditions)}
                  </p>
                </div>
                {canEdit && editingId === null ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setNotice(null);
                        setForm(formFromRow(r));
                        setEditingId(r.id);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Remove the rule “${r.name}”?`)) {
                          setNotice(null);
                          deleteRule.mutate({ id: r.id });
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ) : null}
              </div>
              {editingId === r.id ? editor() : null}
            </div>
          ))}
        </div>
      </Card>

      <TestPanel arch={arch} opts={opts.byAttr} />
    </PageContainer>
  );
}

// ─────────────────────────── test against a requisition ───────────────────────────

function TestPanel({
  arch,
  opts,
}: {
  arch: GetOrgAndJobArchitectureOutput;
  opts: Record<InAttribute, Option[]>;
}) {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<"requisition" | "whatif">("requisition");
  const [search, setSearch] = useState("");
  const reqs = trpc.listApplicabilityRequisitions.useQuery(
    { search: search.trim() || undefined },
    { staleTime: 30_000, refetchOnWindowFocus: false },
  );
  const [requisitionId, setRequisitionId] = useState("");
  const [whatIf, setWhatIf] = useState({
    businessUnitId: "",
    locationId: "",
    jobFunctionId: "",
    jobLevelId: "",
    jobProfileId: "",
    employmentTypeKey: "",
    requisitionTypeKey: "",
  });
  const [result, setResult] = useState<PreviewResolvedConfigurationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const list of Object.values(opts)) for (const o of list) m.set(o.value, o.label);
    return m;
  }, [opts]);

  async function run() {
    setError(null);
    setRunning(true);
    try {
      const input =
        mode === "requisition"
          ? { requisitionId }
          : {
              attributes: {
                businessUnitId: whatIf.businessUnitId || null,
                locationId: whatIf.locationId || null,
                jobFunctionId: whatIf.jobFunctionId || null,
                jobLevelId: whatIf.jobLevelId || null,
                jobProfileId: whatIf.jobProfileId || null,
                employmentTypeKey: whatIf.employmentTypeKey || null,
                requisitionTypeKey: whatIf.requisitionTypeKey || null,
              },
            };
      setResult(await utils.previewResolvedConfiguration.fetch(input));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setRunning(false);
    }
  }

  const pick = (key: keyof typeof whatIf, label: string, options: Option[]) => (
    <Field label={label}>
      <select
        className={inputCls}
        value={whatIf[key]}
        onChange={(e) => setWhatIf({ ...whatIf, [key]: e.target.value })}
      >
        <option value="">— Not set —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );

  const subjectLine = (s: PreviewResolvedConfigurationOutput["subject"]) => {
    const parts: string[] = [];
    if (s.businessUnitId) parts.push(`BU ${labelOf.get(s.businessUnitId) ?? s.businessUnitId}`);
    if (s.legalEntityId) parts.push(`entity ${labelOf.get(s.legalEntityId) ?? s.legalEntityId}`);
    if (s.countryCode) parts.push(`country ${s.countryCode}`);
    if (s.locationId) parts.push(`location ${labelOf.get(s.locationId) ?? s.locationId}`);
    if (s.jobFunctionId) parts.push(`function ${labelOf.get(s.jobFunctionId) ?? s.jobFunctionId}`);
    if (s.jobLevelRank !== null) parts.push(`level rank ${s.jobLevelRank}`);
    if (s.jobProfileId) parts.push(`profile ${labelOf.get(s.jobProfileId) ?? s.jobProfileId}`);
    if (s.employmentTypeKey) parts.push(`employment ${s.employmentTypeKey}`);
    if (s.requisitionTypeKey) parts.push(`type ${s.requisitionTypeKey}`);
    return parts.length ? parts.join(" · ") : "No attributes known";
  };

  return (
    <Card className="mt-6 p-6">
      <h2 className="text-sm font-semibold text-neutral-900">Test against a requisition</h2>
      <p className="mt-1 text-sm text-neutral-500">
        See which template each kind resolves to, and why, without running a hire.
      </p>

      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          variant={mode === "requisition" ? "primary" : "secondary"}
          onClick={() => setMode("requisition")}
        >
          A requisition
        </Button>
        <Button
          size="sm"
          variant={mode === "whatif" ? "primary" : "secondary"}
          onClick={() => setMode("whatif")}
        >
          What if…
        </Button>
      </div>

      {mode === "requisition" ? (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Search by title">
            <input
              className={inputCls}
              value={search}
              maxLength={120}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Requisition">
            <select
              className={inputCls}
              value={requisitionId}
              onChange={(e) => setRequisitionId(e.target.value)}
            >
              <option value="">— Pick one —</option>
              {(reqs.data?.requisitions ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({r.status})
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {pick("businessUnitId", "Business unit", opts.business_unit_id)}
          {pick("locationId", "Location", opts.location_id)}
          {pick("jobFunctionId", "Job function", opts.job_function_id)}
          {pick(
            "jobLevelId",
            "Job level",
            arch.jobLevels.map((l) => ({ value: l.id, label: `${l.label} (${l.key})` })),
          )}
          {pick("jobProfileId", "Job profile", opts.job_profile_id)}
          {pick("employmentTypeKey", "Employment type", opts.employment_type_key)}
          {pick("requisitionTypeKey", "Requisition type", opts.requisition_type_key)}
        </div>
      )}

      <div className="mt-4">
        <Button disabled={running || (mode === "requisition" && !requisitionId)} onClick={run}>
          {running ? "Resolving…" : "Resolve"}
        </Button>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-neutral-500">Resolved for: {subjectLine(result.subject)}</p>
          {result.kinds
            .filter((k) => k.consumed || k.evaluated.length > 0)
            .map((k) => (
              <div key={k.kind} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-neutral-900">{k.label}</span>
                  {k.winner ? (
                    <>
                      <span className="text-sm text-neutral-800">
                        → {k.winner.templateLabel ?? k.winner.templateId}
                      </span>
                      <Badge tone={k.winner.isDefault ? "neutral" : "success"}>
                        {k.winner.isDefault ? "Default rule" : `Rule “${k.winner.name}”`}
                      </Badge>
                    </>
                  ) : (
                    <Badge tone="warning">No rule matched — fallback</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-neutral-600">
                  {k.winner
                    ? k.winner.matchedPredicates.length
                      ? `Matched on ${k.winner.matchedPredicates
                          .map((p) => APPLICABILITY_ATTRIBUTE_LABELS[p])
                          .join(", ")} (priority ${k.winner.priority}).`
                      : `No conditions, so it applies to everything (priority ${k.winner.priority}).`
                    : k.fallback}
                </p>
                {k.ties.length ? (
                  <p className="mt-1 text-xs text-status-warning-800">
                    Tied with {k.ties.map((t) => `“${t.name}”`).join(", ")} on specificity and
                    priority; the newest rule won. Set a priority to make this explicit.
                  </p>
                ) : null}
                {k.evaluated.length ? (
                  <ul className="mt-2 space-y-0.5 text-xs text-neutral-600">
                    {k.evaluated.map((e) => (
                      <li key={e.assignmentId}>
                        <span className="font-medium">{e.name}</span>:{" "}
                        {e.skippedReason
                          ? `skipped (${e.skippedReason})`
                          : e.matches
                            ? "matches"
                            : `no match on ${e.failedPredicates
                                .map((p) => APPLICABILITY_ATTRIBUTE_LABELS[p])
                                .join(", ")}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
        </div>
      ) : null}
    </Card>
  );
}
