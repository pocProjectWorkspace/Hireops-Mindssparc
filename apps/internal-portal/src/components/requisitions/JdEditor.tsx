"use client";

import { useMemo } from "react";
import {
  JD_SECTION_META,
  computeJdCompleteness,
  computeJdReadability,
  computeJdBiasScore,
  BIAS_CATEGORY_META,
  type JdSectionKey,
  type JdSections,
  type JdBiasScan,
  type JdBiasMatch,
} from "@hireops/api-types";
import { Button } from "@/components/ui";

/**
 * RO-02 — the wizard v2 "Job description" step, extracted as a reusable
 * component so it can also mount read-only on the requisition detail (RO-01's
 * surface — see the hand-back merge note). Per-section editor cards over the
 * structured JD sections, each with (for the AI-backed core three) a
 * per-section regenerate that reuses the REAL generateJdDraft path, plus a
 * clear. A "quality strip" reports three deterministic scores:
 *
 *   • Completeness — sections filled / total (pure, computeJdCompleteness)
 *   • Readability  — sentence-length + word-complexity heuristic (documented
 *                    in computeJdReadability)
 *   • Bias check   — derived ENTIRELY from the REAL tenant lexicon scan
 *                    (computeJdBiasScore over summarizeScan) — no new invention.
 *
 * The three AI-backed sections (summary / responsibilities / requirements) are
 * what the real generator produces; the rest are manual-only and honestly
 * labelled "manual".
 */

const textareaCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-50 disabled:text-neutral-500";
const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-50";

/** Caption label. Children are dynamic so it stays a real <label> without an
 *  a11y-lint false positive (same approach as the wizard's Field). */
function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-neutral-700">{children}</label>;
}

export interface JdEditorProps {
  sections: JdSections;
  onChange: (sections: JdSections) => void;
  /** Bias scan of the composed JD (the SAME scanner the submit gate runs). */
  scan: JdBiasScan | null;
  /** Regenerate with the real AI path. `"all"` fills the core three; a key
   *  applies only that AI-backed section. Omitted → editor is display-only. */
  onGenerate?: (target: JdSectionKey | "all") => Promise<void> | void;
  /** Which section is mid-regenerate (for the spinner), or "all". */
  generatingTarget?: JdSectionKey | "all" | null;
  busy?: boolean;
  extraContext?: string;
  onExtraContextChange?: (v: string) => void;
  /** Read-only mount (e.g. the detail page): hides all edit affordances. */
  readOnly?: boolean;
}

export function JdEditor({
  sections,
  onChange,
  scan,
  onGenerate,
  generatingTarget,
  busy = false,
  extraContext,
  onExtraContextChange,
  readOnly = false,
}: JdEditorProps) {
  const completeness = useMemo(() => computeJdCompleteness(sections), [sections]);
  const readability = useMemo(() => computeJdReadability(sections), [sections]);
  const bias = useMemo(() => computeJdBiasScore(scan), [scan]);

  const canGenerate = !readOnly && !!onGenerate;

  function setList(key: JdSectionKey, items: string[]) {
    onChange({ ...sections, [key]: items });
  }
  function setSummary(v: string) {
    onChange({ ...sections, summary: v });
  }
  function clearSection(key: JdSectionKey) {
    if (key === "summary") onChange({ ...sections, summary: "" });
    else onChange({ ...sections, [key]: [] });
  }

  return (
    <div className="space-y-5">
      {canGenerate ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          {onExtraContextChange ? (
            <div className="mb-3">
              <Lbl>Extra context for the AI (optional)</Lbl>
              <textarea
                className={textareaCls}
                rows={2}
                value={extraContext ?? ""}
                onChange={(e) => onExtraContextChange(e.target.value)}
                placeholder="Team is building the payments platform; needs event-streaming depth."
              />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => onGenerate?.("all")} disabled={busy}>
              {generatingTarget === "all"
                ? "Generating…"
                : completeness.filled > 0
                  ? "Regenerate with AI"
                  : "Generate with AI"}
            </Button>
            <span className="text-xs text-neutral-500">
              The AI writes the role summary, responsibilities, and required skills. The remaining
              sections are yours to fill.
            </span>
          </div>
        </div>
      ) : null}

      {/* Quality strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <QualityMeter
          label="Completeness"
          pct={completeness.pct}
          caption={`${completeness.filled} of ${completeness.total} sections`}
        />
        <QualityMeter
          label="Readability"
          pct={readability.pct}
          caption={
            readability.wordCount === 0
              ? "no text yet"
              : `avg ${readability.avgSentenceLength} words/sentence`
          }
        />
        <QualityMeter
          label="Bias check"
          pct={bias.pct}
          caption={
            bias.disabled
              ? "lexicon not enforced"
              : bias.blockingCount + bias.warnCount === 0
                ? "no coded language"
                : `${bias.blockingCount} block · ${bias.warnCount} warn`
          }
          tone={bias.blockingCount > 0 ? "danger" : undefined}
        />
      </div>

      {/* Section cards */}
      <div className="space-y-4">
        {JD_SECTION_META.map((meta) => {
          const key = meta.key;
          const value = sections[key];
          const filled =
            meta.kind === "text"
              ? typeof value === "string" && value.trim().length > 0
              : Array.isArray(value) && value.some((x) => x.trim().length > 0);
          return (
            <div key={key} className="rounded-lg border border-neutral-200 p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-neutral-900">{meta.label}</h3>
                  {meta.aiBacked ? (
                    <span className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">
                      AI-assisted
                    </span>
                  ) : (
                    <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
                      manual
                    </span>
                  )}
                </div>
                {!readOnly ? (
                  <div className="flex items-center gap-2">
                    {meta.aiBacked && canGenerate ? (
                      <button
                        type="button"
                        className="text-xs text-brand-600 hover:underline disabled:text-neutral-400"
                        disabled={busy}
                        onClick={() => onGenerate?.(key)}
                      >
                        {generatingTarget === key ? "Regenerating…" : "Regenerate"}
                      </button>
                    ) : null}
                    {filled ? (
                      <button
                        type="button"
                        className="text-xs text-status-error-600 hover:underline disabled:text-neutral-400"
                        disabled={busy}
                        onClick={() => clearSection(key)}
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {meta.kind === "text" ? (
                <textarea
                  className={textareaCls}
                  rows={3}
                  disabled={readOnly}
                  value={typeof value === "string" ? value : ""}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="A 2–4 sentence overview of the role and its impact."
                />
              ) : (
                <ListEditor
                  items={Array.isArray(value) ? value : []}
                  readOnly={readOnly}
                  onChange={(items) => setList(key, items)}
                />
              )}
            </div>
          );
        })}
      </div>

      <BiasFlagsPanel scan={scan} />
    </div>
  );
}

function toneFor(pct: number): "danger" | "warn" | "ok" {
  if (pct < 50) return "danger";
  if (pct < 75) return "warn";
  return "ok";
}

function QualityMeter({
  label,
  pct,
  caption,
  tone,
}: {
  label: string;
  pct: number;
  caption: string;
  tone?: "danger";
}) {
  const t = tone ?? toneFor(pct);
  const barColor =
    t === "danger"
      ? "bg-status-error-500"
      : t === "warn"
        ? "bg-status-warning-500"
        : "bg-brand-600";
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-neutral-600">{label}</span>
        <span className="text-sm font-semibold text-neutral-900">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">{caption}</p>
    </div>
  );
}

function ListEditor({
  items,
  onChange,
  readOnly,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  readOnly: boolean;
}) {
  if (readOnly) {
    return items.length === 0 ? (
      <p className="text-xs text-neutral-400">None.</p>
    ) : (
      <ul className="list-inside list-disc space-y-1 text-sm text-neutral-800">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-2">
      {items.length === 0 ? <p className="text-xs text-neutral-400">None yet.</p> : null}
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={inputCls}
            value={item}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            type="button"
            className="text-xs text-status-error-600 hover:underline"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-xs text-brand-600 hover:underline"
        onClick={() => onChange([...items, ""])}
      >
        + Add item
      </button>
    </div>
  );
}

const SEVERITY_CHIP: Record<JdBiasMatch["severity"], string> = {
  block: "border-status-error-200 bg-status-error-50 text-status-error-700",
  warn: "border-status-warning-200 bg-status-warning-50 text-status-warning-700",
};

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

/** Live inclusive-language flags (real lexicon scan). Same look as the wizard. */
function BiasFlagsPanel({ scan }: { scan: JdBiasScan | null }) {
  if (!scan || scan.enforcement === "off" || scan.matches.length === 0) return null;
  const flags = distinctMatches(scan.matches);
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
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
