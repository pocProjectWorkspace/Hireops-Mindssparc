"use client";

import { useMemo, useState } from "react";
import {
  slugKey,
  type GetOrgAndJobArchitectureOutput,
  type JobFunctionRow,
  type JobLevelRow,
  type JobProfileCompetency,
  type JobProfileRow,
} from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Job architecture (C1-F3 — Plan A §15 P2): functions → job profiles →
 * levels (grades). The requisition wizard's job-profile picker pre-fills
 * title, function, level and competencies from here; comp bands can be pinned
 * to a level / function / location on the Comp bands page.
 *
 * Keys (function "finance", level "IN12") are the stable values records and
 * imports use — they can't be edited once created; labels, order and rank can.
 * Rows are deactivated, never deleted. hr_head sees the page read-only.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-50";
const labelCls = "mb-1 block text-xs font-medium text-neutral-700";
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
      {children}
    </span>
  );
}

interface ProfileForm {
  title: string;
  defaultJdTemplateId: string;
  jobFunctionId: string;
  jobLevelMinId: string;
  jobLevelMaxId: string;
  canonicalMarketTitle: string;
  /** One competency per line. */
  competenciesText: string;
  isActive: boolean;
}

const EMPTY_PROFILE: ProfileForm = {
  title: "",
  defaultJdTemplateId: "",
  jobFunctionId: "",
  jobLevelMinId: "",
  jobLevelMaxId: "",
  canonicalMarketTitle: "",
  competenciesText: "",
  isActive: true,
};

function profileForm(p: JobProfileRow): ProfileForm {
  return {
    title: p.title,
    defaultJdTemplateId: p.defaultJdTemplateId ?? "",
    jobFunctionId: p.jobFunctionId ?? "",
    jobLevelMinId: p.jobLevelMinId ?? "",
    jobLevelMaxId: p.jobLevelMaxId ?? "",
    canonicalMarketTitle: p.canonicalMarketTitle ?? "",
    competenciesText: p.competencies.map((c) => c.label).join("\n"),
    isActive: p.isActive,
  };
}

/** Lines → competencies; an existing label keeps its key so renames don't churn keys. */
function parseCompetencies(text: string, existing: JobProfileCompetency[]): JobProfileCompetency[] {
  const out: JobProfileCompetency[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const label = line.trim().slice(0, 120);
    if (!label) continue;
    const prior = existing.find((c) => c.label === label);
    let key = prior?.key ?? slugKey(label);
    let n = 2;
    while (seen.has(key)) key = `${slugKey(label).slice(0, 36)}_${n++}`;
    seen.add(key);
    out.push({ key, label });
  }
  return out.slice(0, 30);
}

function profilePayload(f: ProfileForm, existing: JobProfileCompetency[]) {
  return {
    title: f.title.trim(),
    jobFunctionId: f.jobFunctionId || null,
    jobLevelMinId: f.jobLevelMinId || null,
    jobLevelMaxId: f.jobLevelMaxId || null,
    canonicalMarketTitle: f.canonicalMarketTitle.trim() || null,
    defaultJdTemplateId: f.defaultJdTemplateId || null,
    competencies: parseCompetencies(f.competenciesText, existing),
  };
}

export function JobArchitectureClient({
  initial,
  canEdit,
}: {
  initial: GetOrgAndJobArchitectureOutput;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const query = trpc.getOrgAndJobArchitecture.useQuery(
    { includeInactive: true },
    { initialData: initial },
  );
  const data = query.data ?? initial;
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Optional default JD template per profile — the org's JD-template library.
  // FORBIDDEN / empty → the picker just offers "None".
  const templatesQuery = trpc.listJdTemplates.useQuery(
    {},
    { staleTime: 60_000, refetchOnWindowFocus: false, retry: false, enabled: canEdit },
  );
  const jdTemplates = templatesQuery.data?.items ?? [];

  const levelById = useMemo(
    () => new Map(data.jobLevels.map((l) => [l.id, l] as const)),
    [data.jobLevels],
  );
  const fnById = useMemo(
    () => new Map(data.jobFunctions.map((f) => [f.id, f] as const)),
    [data.jobFunctions],
  );

  async function refresh(text: string) {
    await utils.getOrgAndJobArchitecture.invalidate();
    setNotice({ ok: true, text });
  }
  const onError = (err: unknown) => {
    setNotice({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    handleTRPCError(err, { onMessage: () => undefined });
  };

  // ── functions ──
  const [fnDraft, setFnDraft] = useState({ key: "", label: "", sortOrder: "" });
  const [editFn, setEditFn] = useState<JobFunctionRow | null>(null);
  const createFn = trpc.createJobFunction.useMutation({
    onSuccess: async (r) => {
      setFnDraft({ key: "", label: "", sortOrder: "" });
      await refresh(`Added function “${r.row.label}”.`);
    },
    onError,
  });
  const updateFn = trpc.updateJobFunction.useMutation({
    onSuccess: async (r) => {
      setEditFn(null);
      await refresh(`Saved function “${r.row.label}”.`);
    },
    onError,
  });

  // ── levels ──
  const [lvDraft, setLvDraft] = useState({ key: "", label: "", rank: "" });
  const [editLv, setEditLv] = useState<JobLevelRow | null>(null);
  const createLv = trpc.createJobLevel.useMutation({
    onSuccess: async (r) => {
      setLvDraft({ key: "", label: "", rank: "" });
      await refresh(`Added level “${r.row.label}”.`);
    },
    onError,
  });
  const updateLv = trpc.updateJobLevel.useMutation({
    onSuccess: async (r) => {
      setEditLv(null);
      await refresh(`Saved level “${r.row.label}”.`);
    },
    onError,
  });

  // ── profiles ──
  const [profDraft, setProfDraft] = useState<ProfileForm>(EMPTY_PROFILE);
  const [editProfId, setEditProfId] = useState<string | null>(null);
  const [editProf, setEditProf] = useState<ProfileForm>(EMPTY_PROFILE);
  const createProf = trpc.createJobProfile.useMutation({
    onSuccess: async (r) => {
      setProfDraft(EMPTY_PROFILE);
      await refresh(`Added profile “${r.row.title}”.`);
    },
    onError,
  });
  const updateProf = trpc.updateJobProfile.useMutation({
    onSuccess: async (r) => {
      setEditProfId(null);
      await refresh(`Saved profile “${r.row.title}”.`);
    },
    onError,
  });

  const busy =
    createFn.isPending ||
    updateFn.isPending ||
    createLv.isPending ||
    updateLv.isPending ||
    createProf.isPending ||
    updateProf.isPending;

  const levelRange = (p: JobProfileRow) => {
    const min = p.jobLevelMinId ? levelById.get(p.jobLevelMinId) : undefined;
    const max = p.jobLevelMaxId ? levelById.get(p.jobLevelMaxId) : undefined;
    if (min && max && min.id !== max.id) return `${min.label} – ${max.label}`;
    if (min && max) return min.label;
    if (min) return `${min.label} and above`;
    if (max) return `Up to ${max.label}`;
    return "Any level";
  };

  function profileFields(f: ProfileForm, set: (f: ProfileForm) => void) {
    const levelOptions = data.jobLevels.filter(
      (l) => l.isActive || l.id === f.jobLevelMinId || l.id === f.jobLevelMaxId,
    );
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input
            className={inputCls}
            value={f.title}
            maxLength={200}
            onChange={(e) => set({ ...f, title: e.target.value })}
          />
        </Field>
        <Field label="Function">
          <select
            className={inputCls}
            value={f.jobFunctionId}
            onChange={(e) => set({ ...f, jobFunctionId: e.target.value })}
          >
            <option value="">— None —</option>
            {data.jobFunctions
              .filter((x) => x.isActive || x.id === f.jobFunctionId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Lowest level">
          <select
            className={inputCls}
            value={f.jobLevelMinId}
            onChange={(e) => set({ ...f, jobLevelMinId: e.target.value })}
          >
            <option value="">— Any —</option>
            {levelOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label} ({l.key})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Highest level">
          <select
            className={inputCls}
            value={f.jobLevelMaxId}
            onChange={(e) => set({ ...f, jobLevelMaxId: e.target.value })}
          >
            <option value="">— Any —</option>
            {levelOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label} ({l.key})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default JD template (optional)">
          <select
            className={inputCls}
            value={f.defaultJdTemplateId}
            onChange={(e) => set({ ...f, defaultJdTemplateId: e.target.value })}
          >
            <option value="">— None —</option>
            {jdTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Market title (optional, used to match market data)">
          <input
            className={inputCls}
            value={f.canonicalMarketTitle}
            maxLength={200}
            onChange={(e) => set({ ...f, canonicalMarketTitle: e.target.value })}
          />
        </Field>
        <Field label="Competencies (one per line)">
          <textarea
            className={`${inputCls} h-24 py-2`}
            value={f.competenciesText}
            onChange={(e) => set({ ...f, competenciesText: e.target.value })}
          />
        </Field>
      </div>
    );
  }

  const header = (title: string, body: string) => (
    <>
      <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
      <p className="mt-1 text-sm text-neutral-500">{body}</p>
    </>
  );

  return (
    <PageContainer>
      <PageHeader
        title="Job architecture"
        subtitle="Functions, levels and job profiles. A requisition can start from a job profile, which fills in its title, function, level and competencies."
      />

      {!canEdit ? (
        <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
          You can view the job architecture. Changes are made by an administrator.
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

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── Functions ── */}
        <Card className="p-6">
          {header(
            "Functions",
            "Job families, e.g. Finance or Supply chain. The key is permanent; the label is what people see.",
          )}
          {canEdit ? (
            <div className="mt-4 grid grid-cols-[7rem_1fr_5rem_auto] items-end gap-2">
              <Field label="Key">
                <input
                  className={inputCls}
                  value={fnDraft.key}
                  maxLength={40}
                  placeholder="finance"
                  onChange={(e) => setFnDraft({ ...fnDraft, key: e.target.value })}
                />
              </Field>
              <Field label="Label">
                <input
                  className={inputCls}
                  value={fnDraft.label}
                  maxLength={120}
                  onChange={(e) => setFnDraft({ ...fnDraft, label: e.target.value })}
                  onBlur={() =>
                    !fnDraft.key && fnDraft.label.trim()
                      ? setFnDraft({ ...fnDraft, key: slugKey(fnDraft.label) })
                      : undefined
                  }
                />
              </Field>
              <Field label="Order">
                <input
                  type="number"
                  min={0}
                  className={inputCls}
                  value={fnDraft.sortOrder}
                  onChange={(e) => setFnDraft({ ...fnDraft, sortOrder: e.target.value })}
                />
              </Field>
              <Button
                disabled={busy || !KEY_RE.test(fnDraft.key.trim()) || !fnDraft.label.trim()}
                onClick={() =>
                  createFn.mutate({
                    key: fnDraft.key.trim(),
                    label: fnDraft.label.trim(),
                    sortOrder: Number(fnDraft.sortOrder) || 0,
                  })
                }
              >
                Add
              </Button>
            </div>
          ) : null}
          <ul className="mt-4 divide-y divide-neutral-100">
            {data.jobFunctions.length === 0 ? (
              <li className="py-2 text-sm text-neutral-500">No functions yet.</li>
            ) : null}
            {data.jobFunctions.map((f) => (
              <li key={f.id} className="py-2">
                {editFn?.id === f.id ? (
                  <div className="grid grid-cols-[1fr_5rem_auto_auto] items-end gap-2">
                    <Field label="Label">
                      <input
                        className={inputCls}
                        value={editFn.label}
                        maxLength={120}
                        onChange={(e) => setEditFn({ ...editFn, label: e.target.value })}
                      />
                    </Field>
                    <Field label="Order">
                      <input
                        type="number"
                        min={0}
                        className={inputCls}
                        value={editFn.sortOrder}
                        onChange={(e) =>
                          setEditFn({ ...editFn, sortOrder: Number(e.target.value) || 0 })
                        }
                      />
                    </Field>
                    <Button
                      disabled={busy || !editFn.label.trim()}
                      onClick={() =>
                        updateFn.mutate({
                          id: editFn.id,
                          label: editFn.label.trim(),
                          sortOrder: editFn.sortOrder,
                          isActive: editFn.isActive,
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setEditFn(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          f.isActive
                            ? "text-sm text-neutral-900"
                            : "text-sm text-neutral-400 line-through"
                        }
                      >
                        {f.label}
                      </span>
                      <Pill>{f.key}</Pill>
                      {!f.isActive ? <Pill>Inactive</Pill> : null}
                    </div>
                    {canEdit ? (
                      <div className="flex gap-3 text-sm">
                        <button
                          type="button"
                          className="font-medium text-brand-600 hover:underline"
                          disabled={busy}
                          onClick={() => setEditFn(f)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="font-medium text-neutral-600 hover:underline"
                          disabled={busy}
                          onClick={() =>
                            updateFn.mutate({
                              id: f.id,
                              label: f.label,
                              sortOrder: f.sortOrder,
                              isActive: !f.isActive,
                            })
                          }
                        >
                          {f.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>

        {/* ── Levels ── */}
        <Card className="p-6">
          {header(
            "Levels",
            "Grades or bands, ordered by rank (higher = more senior). The key is the grade code a Workday export uses, e.g. IN12.",
          )}
          {canEdit ? (
            <div className="mt-4 grid grid-cols-[7rem_1fr_5rem_auto] items-end gap-2">
              <Field label="Key">
                <input
                  className={inputCls}
                  value={lvDraft.key}
                  maxLength={40}
                  placeholder="IN12"
                  onChange={(e) => setLvDraft({ ...lvDraft, key: e.target.value })}
                />
              </Field>
              <Field label="Label">
                <input
                  className={inputCls}
                  value={lvDraft.label}
                  maxLength={120}
                  onChange={(e) => setLvDraft({ ...lvDraft, label: e.target.value })}
                />
              </Field>
              <Field label="Rank">
                <input
                  type="number"
                  min={0}
                  className={inputCls}
                  value={lvDraft.rank}
                  onChange={(e) => setLvDraft({ ...lvDraft, rank: e.target.value })}
                />
              </Field>
              <Button
                disabled={
                  busy ||
                  !KEY_RE.test(lvDraft.key.trim()) ||
                  !lvDraft.label.trim() ||
                  lvDraft.rank.trim() === ""
                }
                onClick={() =>
                  createLv.mutate({
                    key: lvDraft.key.trim(),
                    label: lvDraft.label.trim(),
                    rank: Number(lvDraft.rank) || 0,
                  })
                }
              >
                Add
              </Button>
            </div>
          ) : null}
          <ul className="mt-4 divide-y divide-neutral-100">
            {data.jobLevels.length === 0 ? (
              <li className="py-2 text-sm text-neutral-500">No levels yet.</li>
            ) : null}
            {data.jobLevels.map((l) => (
              <li key={l.id} className="py-2">
                {editLv?.id === l.id ? (
                  <div className="grid grid-cols-[1fr_5rem_auto_auto] items-end gap-2">
                    <Field label="Label">
                      <input
                        className={inputCls}
                        value={editLv.label}
                        maxLength={120}
                        onChange={(e) => setEditLv({ ...editLv, label: e.target.value })}
                      />
                    </Field>
                    <Field label="Rank">
                      <input
                        type="number"
                        min={0}
                        className={inputCls}
                        value={editLv.rank}
                        onChange={(e) =>
                          setEditLv({ ...editLv, rank: Number(e.target.value) || 0 })
                        }
                      />
                    </Field>
                    <Button
                      disabled={busy || !editLv.label.trim()}
                      onClick={() =>
                        updateLv.mutate({
                          id: editLv.id,
                          label: editLv.label.trim(),
                          rank: editLv.rank,
                          isActive: editLv.isActive,
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setEditLv(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="w-10 text-right text-xs tabular-nums text-neutral-400">
                        {l.rank}
                      </span>
                      <span
                        className={
                          l.isActive
                            ? "text-sm text-neutral-900"
                            : "text-sm text-neutral-400 line-through"
                        }
                      >
                        {l.label}
                      </span>
                      <Pill>{l.key}</Pill>
                      {!l.isActive ? <Pill>Inactive</Pill> : null}
                    </div>
                    {canEdit ? (
                      <div className="flex gap-3 text-sm">
                        <button
                          type="button"
                          className="font-medium text-brand-600 hover:underline"
                          disabled={busy}
                          onClick={() => setEditLv(l)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="font-medium text-neutral-600 hover:underline"
                          disabled={busy}
                          onClick={() =>
                            updateLv.mutate({
                              id: l.id,
                              label: l.label,
                              rank: l.rank,
                              isActive: !l.isActive,
                            })
                          }
                        >
                          {l.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* ── Profiles ── */}
      <Card className="mt-6 p-6">
        {header(
          "Job profiles",
          "The role a requisition starts from: title, function, level range and the competencies the role is assessed on.",
        )}
        {canEdit ? (
          <div className="mt-4 rounded-lg border border-neutral-200 p-4">
            {profileFields(profDraft, setProfDraft)}
            <div className="mt-3">
              <Button
                disabled={busy || profDraft.title.trim().length < 2}
                onClick={() => createProf.mutate(profilePayload(profDraft, []))}
              >
                Add profile
              </Button>
            </div>
          </div>
        ) : null}
        <ul className="mt-4 divide-y divide-neutral-100">
          {data.jobProfiles.length === 0 ? (
            <li className="py-2 text-sm text-neutral-500">No job profiles yet.</li>
          ) : null}
          {data.jobProfiles.map((p) => (
            <li key={p.id} className="py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        p.isActive
                          ? "font-medium text-neutral-900"
                          : "text-neutral-400 line-through"
                      }
                    >
                      {p.title}
                    </span>
                    {p.jobFunctionId ? (
                      <Pill>{fnById.get(p.jobFunctionId)?.label ?? "Unknown function"}</Pill>
                    ) : null}
                    <Pill>{levelRange(p)}</Pill>
                    {!p.isActive ? <Pill>Inactive</Pill> : null}
                  </div>
                  {p.competencies.length > 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">
                      {p.competencies.map((c) => c.label).join(" · ")}
                    </p>
                  ) : null}
                  {p.canonicalMarketTitle ? (
                    <p className="mt-0.5 text-xs text-neutral-400">
                      Market title: {p.canonicalMarketTitle}
                    </p>
                  ) : null}
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 gap-3 text-sm">
                    <button
                      type="button"
                      className="font-medium text-brand-600 hover:underline"
                      disabled={busy}
                      onClick={() => {
                        setEditProfId(p.id);
                        setEditProf(profileForm(p));
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="font-medium text-neutral-600 hover:underline"
                      disabled={busy}
                      onClick={() =>
                        updateProf.mutate({
                          id: p.id,
                          ...profilePayload(profileForm(p), p.competencies),
                          isActive: !p.isActive,
                        })
                      }
                    >
                      {p.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                ) : null}
              </div>
              {editProfId === p.id ? (
                <div className="mt-3 rounded-lg border border-neutral-200 p-4">
                  {profileFields(editProf, setEditProf)}
                  <div className="mt-3 flex gap-3">
                    <Button
                      disabled={busy || editProf.title.trim().length < 2}
                      onClick={() =>
                        updateProf.mutate({
                          id: p.id,
                          ...profilePayload(editProf, p.competencies),
                          isActive: editProf.isActive,
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setEditProfId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </PageContainer>
  );
}
