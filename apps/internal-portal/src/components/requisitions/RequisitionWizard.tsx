"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  summarizeScan,
  scanBlocksSubmit,
  BIAS_CATEGORY_META,
  type JdSections,
  type JdBiasScan,
  type JdBiasMatch,
  type JdAiObservation,
  type RequisitionLocationType,
  type RequisitionSkillInput,
  type RequisitionKnockoutInput,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button, Card } from "@/components/ui";

/**
 * REQ-02 — the requisition creation wizard.
 *
 * Four honest steps: Basics → JD (Generate with AI + editable sections +
 * regenerate) → Skills & knockouts → Review & submit. The draft persists
 * server-side between steps via the REQ-02 mutations; the URL carries the
 * draft requisition id (?rid=) so a reload resumes where the hiring manager
 * left off. No psychometrics, no skill-weight "AI impact" theatre — just the
 * fields the platform actually consumes.
 *
 * On submit the requisition transitions draft → pending_approval and lands in
 * the HR-head queue; the wizard routes to the requisition detail page.
 */

type Step = 1 | 2 | 3 | 4;

const LOCATION_TYPES: RequisitionLocationType[] = ["onsite", "hybrid", "remote", "multi"];
const KNOCKOUT_TYPES: RequisitionKnockoutInput["type"][] = [
  "boolean",
  "numeric_min",
  "numeric_max",
  "enum",
];

interface BasicsState {
  title: string;
  department: string;
  locationType: RequisitionLocationType;
  primaryLocation: string;
  seniority: string;
  employmentType: string;
  numberOfOpenings: number;
  targetStartDate: string;
}

const EMPTY_BASICS: BasicsState = {
  title: "",
  department: "",
  locationType: "onsite",
  primaryLocation: "",
  seniority: "",
  employmentType: "",
  numberOfOpenings: 1,
  targetStartDate: "",
};

const EMPTY_SECTIONS: JdSections = { summary: "", responsibilities: [], requirements: [] };

interface SkillRow extends RequisitionSkillInput {
  key: string;
}
interface KnockoutRow {
  key: string;
  questionText: string;
  type: RequisitionKnockoutInput["type"];
  fieldPath: string;
  value: string; // min/max as string, or comma-separated allowed for enum
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
const textareaCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
const labelCls = "block text-xs font-medium text-neutral-700 mb-1";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

export function RequisitionWizard({ initialRid }: { initialRid: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rid, setRid] = useState<string | null>(initialRid);
  const [step, setStep] = useState<Step>(initialRid ? 2 : 1);
  const [error, setError] = useState<string | null>(null);

  const [basics, setBasics] = useState<BasicsState>(EMPTY_BASICS);
  const [sections, setSections] = useState<JdSections>(EMPTY_SECTIONS);
  const [jdGenerated, setJdGenerated] = useState(false);
  const [extraContext, setExtraContext] = useState("");
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [knockouts, setKnockouts] = useState<KnockoutRow[]>([]);

  const createDraft = trpc.createRequisitionDraft.useMutation();
  const generateJd = trpc.generateJdDraft.useMutation();
  const updateDraft = trpc.updateRequisitionDraft.useMutation();
  const submit = trpc.submitRequisitionForApproval.useMutation();

  // CONF-02: the tenant's effective bias lexicon, scanned client-side over the
  // live JD (debounced) — the SAME scanner the submit gate runs server-side.
  const lexiconQuery = trpc.getBiasLexicon.useQuery({});
  const reviewJd = trpc.reviewJdWithAi.useMutation();
  const [aiObservations, setAiObservations] = useState<JdAiObservation[] | null>(null);
  const [aiReviewError, setAiReviewError] = useState<string | null>(null);

  const busy =
    createDraft.isPending ||
    generateJd.isPending ||
    updateDraft.isPending ||
    submit.isPending ||
    reviewJd.isPending;

  const composedJd = useMemo(
    () =>
      [basics.title, sections.summary, ...sections.responsibilities, ...sections.requirements]
        .filter((s) => s && s.trim().length > 0)
        .join("\n"),
    [basics.title, sections],
  );
  const [debouncedJd, setDebouncedJd] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedJd(composedJd), 300);
    return () => clearTimeout(t);
  }, [composedJd]);
  const scan: JdBiasScan | null = useMemo(
    () => (lexiconQuery.data ? summarizeScan(debouncedJd, lexiconQuery.data) : null),
    [debouncedJd, lexiconQuery.data],
  );

  function setRidInUrl(newRid: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("rid", newRid);
    router.replace(`/requisitions/new?${params.toString()}`);
  }

  async function onCreateBasics() {
    setError(null);
    try {
      const res = await createDraft.mutateAsync({
        title: basics.title,
        department: basics.department,
        locationType: basics.locationType,
        primaryLocation: basics.primaryLocation || undefined,
        seniority: basics.seniority || undefined,
        employmentType: basics.employmentType || undefined,
        numberOfOpenings: basics.numberOfOpenings,
        targetStartDate: basics.targetStartDate || undefined,
      });
      setRid(res.requisitionId);
      setRidInUrl(res.requisitionId);
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onGenerateJd() {
    if (!rid) return;
    setError(null);
    try {
      const res = await generateJd.mutateAsync({
        requisitionId: rid,
        extraContext: extraContext || undefined,
      });
      setSections(res.sections);
      setJdGenerated(true);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onReviewJd() {
    if (!rid) return;
    setAiReviewError(null);
    setError(null);
    try {
      // Persist the current sections first so the AI reviews exactly what the
      // author sees (generateJdDraft persisted its own output; local edits
      // since then would otherwise be invisible to the server read).
      await updateDraft.mutateAsync({ requisitionId: rid, sections });
      const res = await reviewJd.mutateAsync({ requisitionId: rid });
      setAiObservations(res.observations);
    } catch (err) {
      setAiReviewError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onSaveJdAndNext() {
    if (!rid) return;
    setError(null);
    try {
      await updateDraft.mutateAsync({ requisitionId: rid, sections });
      setStep(3);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onSaveSkillsAndNext() {
    if (!rid) return;
    setError(null);
    try {
      await updateDraft.mutateAsync({
        requisitionId: rid,
        skills: skills.map((s) => ({
          skillName: s.skillName,
          weight: s.weight,
          isRequired: s.isRequired,
        })),
        knockouts: knockouts.map(toKnockoutInput),
      });
      setStep(4);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onSubmit() {
    if (!rid) return;
    setError(null);
    try {
      await submit.mutateAsync({ requisitionId: rid });
      router.push(`/requisitions/${rid}`);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-6">
      <Stepper step={step} />
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {step === 1 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-4 text-base font-semibold text-neutral-900">Role basics</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Field label="Job title">
                <input
                  className={inputCls}
                  value={basics.title}
                  onChange={(e) => setBasics({ ...basics, title: e.target.value })}
                  placeholder="Senior Backend Engineer"
                />
              </Field>
            </div>
            <Field label="Department / business unit">
              <input
                className={inputCls}
                value={basics.department}
                onChange={(e) => setBasics({ ...basics, department: e.target.value })}
                placeholder="GCC — Bengaluru"
              />
            </Field>
            <Field label="Seniority">
              <input
                className={inputCls}
                value={basics.seniority}
                onChange={(e) => setBasics({ ...basics, seniority: e.target.value })}
                placeholder="Senior"
              />
            </Field>
            <Field label="Location type">
              <select
                className={inputCls}
                value={basics.locationType}
                onChange={(e) =>
                  setBasics({ ...basics, locationType: e.target.value as RequisitionLocationType })
                }
              >
                {LOCATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Primary location">
              <input
                className={inputCls}
                value={basics.primaryLocation}
                onChange={(e) => setBasics({ ...basics, primaryLocation: e.target.value })}
                placeholder="Bengaluru"
              />
            </Field>
            <Field label="Employment type">
              <input
                className={inputCls}
                value={basics.employmentType}
                onChange={(e) => setBasics({ ...basics, employmentType: e.target.value })}
                placeholder="Full-time"
              />
            </Field>
            <Field label="Openings">
              <input
                type="number"
                min={1}
                className={inputCls}
                value={basics.numberOfOpenings}
                onChange={(e) =>
                  setBasics({ ...basics, numberOfOpenings: Number(e.target.value) || 1 })
                }
              />
            </Field>
            <Field label="Target start date">
              <input
                type="date"
                className={inputCls}
                value={basics.targetStartDate}
                onChange={(e) => setBasics({ ...basics, targetStartDate: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-6 flex justify-end">
            <Button
              onClick={onCreateBasics}
              disabled={busy || basics.title.trim().length < 2 || !basics.department.trim()}
            >
              {createDraft.isPending ? "Creating…" : "Create draft & continue"}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">Job description</h2>
          <p className="mb-4 text-sm text-neutral-600">
            Generate a first draft with AI, then edit any section. Regenerate as often as you like
            while the requisition is a draft.
          </p>
          <Field label="Extra context for the AI (optional)">
            <textarea
              className={textareaCls}
              rows={2}
              value={extraContext}
              onChange={(e) => setExtraContext(e.target.value)}
              placeholder="Team is building the payments platform; needs event-streaming depth."
            />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onGenerateJd} disabled={busy}>
              {generateJd.isPending
                ? "Generating…"
                : jdGenerated
                  ? "Regenerate with AI"
                  : "Generate with AI"}
            </Button>
            <Button
              variant="ghost"
              onClick={onReviewJd}
              disabled={busy || sections.summary.trim().length === 0}
              title="Optional AI inclusive-language review — advisory, never blocks"
            >
              {reviewJd.isPending ? "Reviewing…" : "Review with AI"}
            </Button>
          </div>

          <div className="mt-6 space-y-4">
            <Field label="Summary">
              <textarea
                className={textareaCls}
                rows={3}
                value={sections.summary}
                onChange={(e) => setSections({ ...sections, summary: e.target.value })}
              />
            </Field>
            <ListEditor
              label="Responsibilities"
              items={sections.responsibilities}
              onChange={(responsibilities) => setSections({ ...sections, responsibilities })}
            />
            <ListEditor
              label="Requirements"
              items={sections.requirements}
              onChange={(requirements) => setSections({ ...sections, requirements })}
            />
          </div>

          <BiasFlagsPanel scan={scan} />

          {aiReviewError ? (
            <div className="mt-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
              {aiReviewError}
            </div>
          ) : null}
          {aiObservations ? <AiReviewCards observations={aiObservations} /> : null}

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
              Back
            </Button>
            <Button
              onClick={onSaveJdAndNext}
              disabled={busy || sections.summary.trim().length === 0}
            >
              {updateDraft.isPending ? "Saving…" : "Save & continue"}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">Skills & knockouts</h2>
          <p className="mb-4 text-sm text-neutral-600">
            Skills feed the AI candidate scoring. Knockouts are hard gates evaluated against the
            parsed CV at apply time.
          </p>

          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-neutral-800">Skills</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSkills([...skills, { key: uid(), skillName: "", weight: 1, isRequired: true }])
                }
              >
                + Add skill
              </Button>
            </div>
            {skills.length === 0 ? (
              <p className="text-xs text-neutral-500">
                No skills yet — add at least one to submit.
              </p>
            ) : (
              <div className="space-y-2">
                {skills.map((s) => (
                  <div key={s.key} className="flex items-center gap-2">
                    <input
                      className={inputCls}
                      value={s.skillName}
                      placeholder="Kafka"
                      onChange={(e) =>
                        setSkills(
                          skills.map((x) =>
                            x.key === s.key ? { ...x, skillName: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      max={10}
                      className={`${inputCls} w-24`}
                      value={s.weight}
                      title="Weight"
                      onChange={(e) =>
                        setSkills(
                          skills.map((x) =>
                            x.key === s.key ? { ...x, weight: Number(e.target.value) || 0 } : x,
                          ),
                        )
                      }
                    />
                    <label className="flex items-center gap-1 whitespace-nowrap text-xs text-neutral-600">
                      <input
                        type="checkbox"
                        checked={s.isRequired}
                        onChange={(e) =>
                          setSkills(
                            skills.map((x) =>
                              x.key === s.key ? { ...x, isRequired: e.target.checked } : x,
                            ),
                          )
                        }
                      />
                      Must-have
                    </label>
                    <button
                      className="text-xs text-status-error-600 hover:underline"
                      onClick={() => setSkills(skills.filter((x) => x.key !== s.key))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-neutral-800">Knockouts</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setKnockouts([
                    ...knockouts,
                    {
                      key: uid(),
                      questionText: "",
                      type: "numeric_min",
                      fieldPath: "total_years_experience",
                      value: "",
                    },
                  ])
                }
              >
                + Add knockout
              </Button>
            </div>
            {knockouts.length === 0 ? (
              <p className="text-xs text-neutral-500">
                Optional — hard gates like &ldquo;≥ 5 years experience&rdquo;.
              </p>
            ) : (
              <div className="space-y-3">
                {knockouts.map((k) => (
                  <div key={k.key} className="rounded-lg border border-neutral-200 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <input
                          className={inputCls}
                          value={k.questionText}
                          placeholder="Minimum 5 years of backend experience"
                          onChange={(e) =>
                            setKnockouts(
                              knockouts.map((x) =>
                                x.key === k.key ? { ...x, questionText: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </div>
                      <select
                        className={inputCls}
                        value={k.type}
                        onChange={(e) =>
                          setKnockouts(
                            knockouts.map((x) =>
                              x.key === k.key
                                ? { ...x, type: e.target.value as KnockoutRow["type"] }
                                : x,
                            ),
                          )
                        }
                      >
                        {KNOCKOUT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <input
                        className={inputCls}
                        value={k.fieldPath}
                        placeholder="total_years_experience"
                        title="Parsed-CV field path"
                        onChange={(e) =>
                          setKnockouts(
                            knockouts.map((x) =>
                              x.key === k.key ? { ...x, fieldPath: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      {k.type !== "boolean" ? (
                        <div className="col-span-2">
                          <input
                            className={inputCls}
                            value={k.value}
                            placeholder={
                              k.type === "enum"
                                ? "Allowed values, comma-separated"
                                : "Threshold number"
                            }
                            onChange={(e) =>
                              setKnockouts(
                                knockouts.map((x) =>
                                  x.key === k.key ? { ...x, value: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                    <button
                      className="mt-2 text-xs text-status-error-600 hover:underline"
                      onClick={() => setKnockouts(knockouts.filter((x) => x.key !== k.key))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)} disabled={busy}>
              Back
            </Button>
            <Button onClick={onSaveSkillsAndNext} disabled={busy}>
              {updateDraft.isPending ? "Saving…" : "Save & continue"}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-4 text-base font-semibold text-neutral-900">Review & submit</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Title" value={basics.title} />
            <Row label="Department" value={basics.department} />
            <Row
              label="Location"
              value={`${basics.primaryLocation || "—"} (${basics.locationType})`}
            />
            <Row label="Openings" value={String(basics.numberOfOpenings)} />
            <Row label="JD summary" value={sections.summary || "—"} />
            <Row label="Skills" value={skills.map((s) => s.skillName).join(", ") || "—"} />
            <Row label="Knockouts" value={String(knockouts.length)} />
          </dl>

          <GateStatus scan={scan} />

          <p className="mt-4 text-xs text-neutral-500">
            Submitting sends this requisition to the HR head for approval. You can&rsquo;t edit it
            after submission.
          </p>
          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(3)} disabled={busy}>
              Back
            </Button>
            <Button onClick={onSubmit} disabled={busy}>
              {submit.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function toKnockoutInput(k: KnockoutRow): RequisitionKnockoutInput {
  const base = {
    questionText: k.questionText,
    type: k.type,
    source: "parsed_cv" as const,
    fieldPath: k.fieldPath,
  };
  if (k.type === "numeric_min") return { ...base, min: Number(k.value) || 0 };
  if (k.type === "numeric_max") return { ...base, max: Number(k.value) || 0 };
  if (k.type === "enum")
    return {
      ...base,
      allowed: k.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  return base;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

function ListEditor({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className={labelCls}>{label}</label>
        <button
          className="text-xs text-brand-600 hover:underline"
          onClick={() => onChange([...items, ""])}
        >
          + Add
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-neutral-400">None yet.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={inputCls}
                value={item}
                onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                className="text-xs text-status-error-600 hover:underline"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const labels = ["Basics", "JD", "Skills & knockouts", "Review"];
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs">
      {labels.map((l, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        return (
          <li key={l} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                active
                  ? "bg-brand-600 text-white"
                  : done
                    ? "bg-brand-100 text-brand-700"
                    : "bg-neutral-100 text-neutral-500"
              }`}
            >
              {n}
            </span>
            <span className={active ? "font-medium text-neutral-900" : "text-neutral-500"}>
              {l}
            </span>
            {i < labels.length - 1 ? <span className="text-neutral-300">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong. Please try again.";
}

const SEVERITY_CHIP: Record<JdBiasMatch["severity"], string> = {
  block: "border-status-error-200 bg-status-error-50 text-status-error-700",
  warn: "border-status-warning-200 bg-status-warning-50 text-status-warning-700",
};

/** Distinct matches by term+category, first-seen order (mirrors the server). */
function distinctMatches(matches: JdBiasMatch[]): JdBiasMatch[] {
  const seen = new Set<string>();
  const out: JdBiasMatch[] = [];
  for (const m of matches) {
    const key = `${m.term.toLowerCase()}|${m.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Live inclusive-language flags in the JD step. Chips + suggestions. */
function BiasFlagsPanel({ scan }: { scan: JdBiasScan | null }) {
  if (!scan || scan.enforcement === "off" || scan.matches.length === 0) return null;
  const flags = distinctMatches(scan.matches);
  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <p className="mb-2 text-xs font-medium text-neutral-700">
        Inclusive-language check — {flags.length} {flags.length === 1 ? "flag" : "flags"}
        {scan.enforcement === "block" && scan.blockingCount > 0
          ? ` (${scan.blockingCount} must be revised before submit)`
          : ""}
      </p>
      <div className="space-y-1.5">
        {flags.map((m) => (
          <div key={`${m.term}-${m.category}`} className="flex flex-wrap items-baseline gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_CHIP[m.severity]}`}
            >
              {m.matchedText}
            </span>
            <span className="text-[11px] text-neutral-500">
              {BIAS_CATEGORY_META[m.category].label}
            </span>
            {m.suggestion ? (
              <span className="text-xs text-neutral-600">— {m.suggestion}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Advisory AI-assisted observations. Clearly labelled, never blocking. */
function AiReviewCards({ observations }: { observations: JdAiObservation[] }) {
  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-medium text-brand-700">
        AI-assisted review — advisory only, does not block submission
      </p>
      {observations.length === 0 ? (
        <p className="text-sm text-neutral-500">
          The AI reviewer flagged nothing beyond the lexicon check.
        </p>
      ) : (
        <div className="space-y-2">
          {observations.map((o, i) => (
            <div key={i} className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <p className="text-xs italic text-neutral-500">&ldquo;{o.excerpt}&rdquo;</p>
              <p className="mt-1 text-sm text-neutral-800">{o.issue}</p>
              <p className="mt-1 text-sm text-brand-700">Suggestion: {o.suggestion}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Review-step gate status: clean / warnings / blocked. */
function GateStatus({ scan }: { scan: JdBiasScan | null }) {
  if (!scan || scan.enforcement === "off") return null;
  const blocked = scanBlocksSubmit(scan);
  if (blocked) {
    const blocking = distinctMatches(scan.matches.filter((m) => m.severity === "block"));
    return (
      <div className="mt-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
        <p className="font-medium">
          Bias gate: blocked — {blocking.length} {blocking.length === 1 ? "term" : "terms"} must be
          revised before you can submit.
        </p>
        <ul className="mt-1 list-inside list-disc">
          {blocking.map((m) => (
            <li key={m.term}>
              &ldquo;{m.matchedText}&rdquo;{m.suggestion ? ` — ${m.suggestion}` : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (scan.matches.length > 0) {
    return (
      <div className="mt-4 rounded-lg border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-700">
        Bias gate: {scan.matches.length} flagged {scan.matches.length === 1 ? "phrase" : "phrases"}{" "}
        — submission is allowed; the HR head will see the flags in the approval queue.
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
      Bias gate: clean — no coded language found.
    </div>
  );
}
