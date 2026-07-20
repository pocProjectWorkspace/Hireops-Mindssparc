"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Button } from "@/components/ui";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * T0.1 (G01) — the agent AUTHORING modal. The platform's automation spine
 * had working backend CREATE/UPDATE/RETIRE procedures but no UI to author
 * an agent; an org could only toggle seeded ones. This wires those
 * existing procedures to a curated form.
 *
 * Scope is deliberately the THREE existing recipes only (follow-up,
 * scheduling, candidate-QA) — a recipe picker, then the curated HR-facing
 * fields per recipe (name/description + the trigger/draft knobs the input
 * schemas expose). The platform-curated knobs (template_prompt_id,
 * channel, outbox_kind, approver_role) stay inside the procedures and are
 * NOT surfaced. This is not a general trigger/action composer — that is a
 * later ticket (G03).
 *
 * HONESTY: every recipe here DRAFTS or PROPOSES and STOPS for a human.
 * The approval line under each recipe states the REAL gate the create
 * procedure attaches (follow-up + candidate-QA wait for approval before
 * anything sends; scheduling lets a recruiter review proposed slots). No
 * auto-send is possible from this surface.
 *
 * Edit follows the backend's retire-and-insert versioning model, so the
 * NAME is immutable on edit (name-anchored lineage) — the form shows it
 * read-only in edit mode. Retire is non-destructive (sets retired_at).
 */

export type RecipeKey = "follow_up" | "scheduling" | "candidate_qa";

type ToneValue = "formal" | "friendly" | "neutral";

const APPLICATION_STAGES = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
] as const;

const TONES: { value: ToneValue; label: string }[] = [
  { value: "friendly", label: "Friendly" },
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
];

interface RecipeMeta {
  key: RecipeKey;
  label: string;
  blurb: string;
  /** The REAL human-in-the-loop gate the create procedure attaches. */
  approvalLine: string;
}

export const RECIPES: RecipeMeta[] = [
  {
    key: "follow_up",
    label: "Follow-up check-in",
    blurb:
      "Watches a pipeline stage and drafts a short check-in email when an application has been sitting there past a threshold.",
    approvalLine:
      "Drafts the email and waits for the owning recruiter to approve it — nothing sends until a person signs off.",
  },
  {
    key: "scheduling",
    label: "Interview scheduling",
    blurb:
      "When a candidate reaches the chosen stage, proposes interview slots against the panel's calendar and books the settled slot.",
    approvalLine:
      "Proposes slots for the owning recruiter to review before they are offered; the booking follows once slots are settled.",
  },
  {
    key: "candidate_qa",
    label: "Candidate Q&A reply",
    blurb:
      "When a candidate emails a question, drafts a reply grounded only in their real application status — never invented facts.",
    approvalLine:
      "Every reply waits for the owning recruiter to approve it — nothing reaches the candidate automatically.",
  },
];

/** Shape the form edits; superset of all three recipes' fields. */
interface FormState {
  name: string;
  description: string;
  // follow_up + scheduling
  stage: string;
  // follow_up
  days_threshold: string;
  // follow_up + candidate_qa
  tone: ToneValue;
  max_tokens: string;
  // scheduling
  panel_id: string;
  slot_count: string;
  window_days: string;
  duration_minutes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  stage: "shortlisted",
  days_threshold: "5",
  tone: "friendly",
  max_tokens: "200",
  panel_id: "",
  slot_count: "3",
  window_days: "7",
  duration_minutes: "45",
};

export interface AgentFormModalProps {
  mode: "create" | "edit";
  /** Fixed in edit mode; chosen via the picker in create mode. */
  recipe?: RecipeKey;
  /** Required in edit mode — the active agent's id. */
  agentId?: string;
  /**
   * Prefill values in edit mode (from getAgentDetail configs). All fields
   * arrive as strings (jsonb passthrough); tone is coerced back to its
   * union at merge time.
   */
  initial?: Partial<Record<keyof FormState, string>>;
  onClose: () => void;
  onSaved: () => void;
}

const TONE_VALUES: ToneValue[] = ["formal", "friendly", "neutral"];

function normalizeInitial(initial?: Partial<Record<keyof FormState, string>>): FormState {
  const merged: FormState = { ...EMPTY_FORM };
  if (!initial) return merged;
  for (const [key, value] of Object.entries(initial)) {
    if (value === undefined) continue;
    if (key === "tone") {
      merged.tone = TONE_VALUES.includes(value as ToneValue)
        ? (value as ToneValue)
        : EMPTY_FORM.tone;
    } else if (key in merged) {
      (merged as unknown as Record<string, string>)[key] = value;
    }
  }
  return merged;
}

export function AgentFormModal({
  mode,
  recipe: fixedRecipe,
  agentId,
  initial,
  onClose,
  onSaved,
}: AgentFormModalProps) {
  const [recipe, setRecipe] = useState<RecipeKey | null>(fixedRecipe ?? null);
  const [form, setForm] = useState<FormState>(() => normalizeInitial(initial));
  const [error, setError] = useState<string | null>(null);

  // Esc-to-close + scroll lock, mirroring AgentDetailDrawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // All create/update hooks instantiated up front (hooks can't be conditional)
  // and picked at submit time — same shape as WorkflowsClient's toggles.
  const createFollowUp = trpc.createFollowUpAgent.useMutation();
  const createScheduling = trpc.createSchedulingAgent.useMutation();
  const createCandidateQa = trpc.createCandidateQaAgent.useMutation();
  const updateFollowUp = trpc.updateFollowUpAgent.useMutation();
  const updateScheduling = trpc.updateSchedulingAgent.useMutation();
  const updateCandidateQa = trpc.updateCandidateQaAgent.useMutation();

  const pending =
    createFollowUp.isPending ||
    createScheduling.isPending ||
    createCandidateQa.isPending ||
    updateFollowUp.isPending ||
    updateScheduling.isPending ||
    updateCandidateQa.isPending;

  const meta = useMemo(() => RECIPES.find((r) => r.key === recipe) ?? null, [recipe]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    if (!recipe) return;
    setError(null);

    try {
      if (mode === "create") {
        if (recipe === "follow_up") {
          await createFollowUp.mutateAsync({
            name: form.name.trim(),
            description: emptyToUndef(form.description),
            stage: form.stage as never,
            days_threshold: toInt(form.days_threshold, 5),
            tone: form.tone,
            max_tokens: toInt(form.max_tokens, 200),
          });
        } else if (recipe === "scheduling") {
          await createScheduling.mutateAsync({
            name: form.name.trim(),
            description: emptyToUndef(form.description),
            stage: form.stage,
            panel_id: form.panel_id.trim(),
            slot_count: toInt(form.slot_count, 3),
            window_days: toInt(form.window_days, 7),
            duration_minutes: toInt(form.duration_minutes, 45),
          });
        } else {
          await createCandidateQa.mutateAsync({
            name: form.name.trim(),
            description: emptyToUndef(form.description),
            tone: form.tone,
            max_tokens: toInt(form.max_tokens, 200),
          });
        }
      } else {
        // edit — name is immutable (versioned lineage), so it is omitted.
        if (!agentId) throw new Error("missing agentId for edit");
        if (recipe === "follow_up") {
          await updateFollowUp.mutateAsync({
            agentId,
            description: emptyToNull(form.description),
            stage: form.stage as never,
            days_threshold: toInt(form.days_threshold, 5),
            tone: form.tone,
            max_tokens: toInt(form.max_tokens, 200),
          });
        } else if (recipe === "scheduling") {
          await updateScheduling.mutateAsync({
            agentId,
            description: emptyToNull(form.description),
            stage: form.stage,
            panel_id: form.panel_id.trim(),
            slot_count: toInt(form.slot_count, 3),
            window_days: toInt(form.window_days, 7),
            duration_minutes: toInt(form.duration_minutes, 45),
          });
        } else {
          await updateCandidateQa.mutateAsync({
            agentId,
            description: emptyToNull(form.description),
            tone: form.tone,
            max_tokens: toInt(form.max_tokens, 200),
          });
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      // Surface the server message inline (e.g. duplicate active name) AND
      // route through the shared toast handler.
      setError(errMessage(err));
      handleTRPCError(err);
    }
  }

  const canSubmit =
    !!recipe &&
    (mode === "edit" || form.name.trim().length > 0) &&
    (recipe !== "scheduling" || form.panel_id.trim().length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === "create" ? "Create workflow" : "Edit workflow"}
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto p-4 sm:p-8"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-neutral-900/40"
      />
      <div className="relative z-10 w-full max-w-lg rounded-xl bg-white shadow-3">
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
              {mode === "create" ? "Create workflow" : "Edit workflow"}
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              {mode === "create"
                ? "Pick a recipe, then set its knobs. Every agent drafts or proposes and stops for a human — HireOps never sends on its own."
                : "Editing creates a new version; the previous version is retired and kept for history. The name is fixed across versions."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          {/* Step 1 (create only): recipe picker. */}
          {mode === "create" && !recipe ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Choose a recipe
              </p>
              <ul className="space-y-2">
                {RECIPES.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      onClick={() => setRecipe(r.key)}
                      className="w-full rounded-lg border border-neutral-200 p-4 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                    >
                      <span className="text-sm font-semibold text-neutral-900">{r.label}</span>
                      <p className="mt-0.5 text-xs text-neutral-500">{r.blurb}</p>
                      <p className="mt-2 text-[11px] font-medium text-brand-700">
                        {r.approvalLine}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              {meta ? (
                <div className="rounded-lg border border-brand-100 bg-brand-50 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Badge tone="accent">{meta.label}</Badge>
                  </div>
                  <p className="mt-2 text-[11px] font-medium text-brand-800">{meta.approvalLine}</p>
                </div>
              ) : null}

              <Field label="Name">
                {mode === "edit" ? (
                  <p className="flex h-9 items-center rounded-button border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-500">
                    {form.name || "—"}
                  </p>
                ) : (
                  <input
                    className={inputCls}
                    value={form.name}
                    maxLength={100}
                    placeholder="e.g. Stale application check-in"
                    onChange={(e) => set("name", e.target.value)}
                  />
                )}
              </Field>

              <Field label="Description (optional)">
                <textarea
                  className={`${inputCls} h-auto py-2`}
                  rows={2}
                  maxLength={500}
                  value={form.description}
                  placeholder="What this agent is for."
                  onChange={(e) => set("description", e.target.value)}
                />
              </Field>

              {recipe === "follow_up" ? (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Stage to watch">
                    <StageSelect value={form.stage} onChange={(v) => set("stage", v)} />
                  </Field>
                  <Field label="Days at stage before firing">
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      max={365}
                      value={form.days_threshold}
                      onChange={(e) => set("days_threshold", e.target.value)}
                    />
                  </Field>
                  <Field label="Tone">
                    <ToneSelect value={form.tone} onChange={(v) => set("tone", v)} />
                  </Field>
                  <Field label="Max tokens per draft">
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      max={2000}
                      value={form.max_tokens}
                      onChange={(e) => set("max_tokens", e.target.value)}
                    />
                  </Field>
                </div>
              ) : null}

              {recipe === "scheduling" ? (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Stage that triggers scheduling">
                    <StageSelect value={form.stage} onChange={(v) => set("stage", v)} />
                  </Field>
                  <Field label="Panel ID">
                    <input
                      className={inputCls}
                      value={form.panel_id}
                      maxLength={100}
                      placeholder="Interview panel identifier"
                      onChange={(e) => set("panel_id", e.target.value)}
                    />
                  </Field>
                  <Field label="Slots to propose">
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      max={20}
                      value={form.slot_count}
                      onChange={(e) => set("slot_count", e.target.value)}
                    />
                  </Field>
                  <Field label="Look-ahead window (days)">
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      max={60}
                      value={form.window_days}
                      onChange={(e) => set("window_days", e.target.value)}
                    />
                  </Field>
                  <Field label="Interview length (minutes)">
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      max={480}
                      value={form.duration_minutes}
                      onChange={(e) => set("duration_minutes", e.target.value)}
                    />
                  </Field>
                </div>
              ) : null}

              {recipe === "candidate_qa" ? (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Tone">
                    <ToneSelect value={form.tone} onChange={(v) => set("tone", v)} />
                  </Field>
                  <Field label="Max tokens per draft">
                    <input
                      className={inputCls}
                      type="number"
                      min={1}
                      max={2000}
                      value={form.max_tokens}
                      onChange={(e) => set("max_tokens", e.target.value)}
                    />
                  </Field>
                  <div className="col-span-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] text-neutral-500">
                    Fires on a candidate email; drafts a reply grounded only in that
                    candidate&apos;s real application status. It never invents dates, decisions, or
                    figures.
                  </div>
                </div>
              ) : null}

              {error ? (
                <p className="rounded-lg border border-status-error-200 bg-status-error-50 px-3 py-2 text-xs text-status-error-700">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </div>

        {recipe ? (
          <footer className="flex items-center justify-between gap-3 border-t border-neutral-200 px-6 py-4">
            <div>
              {mode === "create" && !fixedRecipe ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRecipe(null)}
                  disabled={pending}
                >
                  ← Change recipe
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={!canSubmit || pending}>
                {pending ? "Saving…" : mode === "create" ? "Create workflow" : "Save new version"}
              </Button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
const labelCls = "block text-xs font-medium text-neutral-700 mb-1";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

function StageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {APPLICATION_STAGES.map((s) => (
        <option key={s} value={s}>
          {humanizeStage(s)}
        </option>
      ))}
    </select>
  );
}

function ToneSelect({ value, onChange }: { value: ToneValue; onChange: (v: ToneValue) => void }) {
  return (
    <select
      className={inputCls}
      value={value}
      onChange={(e) => onChange(e.target.value as ToneValue)}
    >
      {TONES.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

function humanizeStage(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function emptyToUndef(v: string): string | undefined {
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function emptyToNull(v: string): string | null {
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function toInt(v: string, fallback: number): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return "Something went wrong saving this workflow.";
}
