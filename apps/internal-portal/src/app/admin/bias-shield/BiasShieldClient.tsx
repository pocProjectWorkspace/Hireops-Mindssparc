"use client";

import { useMemo } from "react";
import {
  type BiasLexicon,
  type BiasCategory,
  type BiasEnforcementMode,
  BIAS_CATEGORIES,
  BIAS_CATEGORY_META,
} from "@hireops/api-types";
import { Card, Badge, type BadgeTone } from "@/components/ui";

/**
 * Bias Shield (AD11) — a confident, designed statement of HireOps' bias
 * posture. The centerpiece is the REFUSAL: we do not collect or infer
 * protected attributes and build no demographic scoring/monitoring. Below it,
 * the REAL controls we DO run (the deterministic JD lexicon + blind screening),
 * read live from getBiasLexicon.
 */

const ENFORCEMENT_META: Record<
  BiasEnforcementMode,
  { label: string; tone: BadgeTone; blurb: string }
> = {
  off: {
    label: "Off",
    tone: "neutral",
    blurb: "The gate is disabled. No JD language is flagged.",
  },
  warn: {
    label: "Warn",
    tone: "warning",
    blurb: "Flagged language is recorded for the HR head; submissions still proceed.",
  },
  block: {
    label: "Block",
    tone: "error",
    blurb: "Terms marked ‘block’ stop a submission until the wording is revised.",
  },
};

// The prototype's demographic rules — named explicitly so the refusal is
// concrete, not hand-wavy. We do NOT implement any of these.
const REFUSED_DEMOGRAPHIC_RULES = [
  "Gender-balance percentage targets on shortlists",
  "Ethnicity / age correlation analysis on candidates",
  "Salary-equity scoring broken down by gender",
  "Panel-diversity quotas and scoring",
  "“Interview times correlate with demographics” monitoring",
  "Any protected-class inference from names, photos, or CVs",
];

export function BiasShieldClient({ lexicon }: { lexicon: BiasLexicon }) {
  const enforcement = lexicon.enforcement;
  const enfMeta = ENFORCEMENT_META[enforcement];

  const byCategory = useMemo(() => {
    const counts: Record<BiasCategory, { warn: number; block: number }> = {
      gendered: { warn: 0, block: 0 },
      age_coded: { warn: 0, block: 0 },
      exclusionary: { warn: 0, block: 0 },
      superlative_pressure: { warn: 0, block: 0 },
    };
    for (const e of lexicon.entries) {
      const bucket = counts[e.category];
      if (bucket) bucket[e.severity] += 1;
    }
    return counts;
  }, [lexicon.entries]);

  const totalTerms = lexicon.entries.length;
  const totalBlock = lexicon.entries.filter((e) => e.severity === "block").length;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      {/* ── The refusal centerpiece ── */}
      <section className="mb-8 overflow-hidden rounded-2xl border border-brand-200 bg-brand-50">
        <div className="px-7 py-7">
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
              Compliance by design
            </span>
            <span className="text-xs font-medium text-neutral-500">EU AI Act aligned</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-900">
            HireOps does not score people by who they are.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-700">
            We deliberately collect and infer{" "}
            <span className="font-semibold">no protected attributes</span> — no gender, ethnicity,
            age, or demographic signal — and we build{" "}
            <span className="font-semibold">no demographic scoring or monitoring</span> anywhere in
            the platform. There is nothing to switch off here, because it was never built. A hiring
            system that measured people by protected class would be exactly the high-risk profiling
            the EU AI Act restricts. Our bias controls act on the{" "}
            <span className="font-semibold">text of a job description</span> and on{" "}
            <span className="font-semibold">what a reviewer can see</span> — never on the person.
          </p>
        </div>

        <div className="border-t border-brand-100 bg-white/70 px-7 py-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Deliberately not built
          </p>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
            {REFUSED_DEMOGRAPHIC_RULES.map((rule) => (
              <li key={rule} className="flex items-start gap-2 text-sm text-neutral-700">
                <span aria-hidden className="mt-0.5 text-status-error-500">
                  ✕
                </span>
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── What we DO run ── */}
      <h3 className="mb-1 text-base font-semibold text-neutral-900">
        What the shield actually does
      </h3>
      <p className="mb-4 max-w-2xl text-sm text-neutral-600">
        Two real, deterministic controls — no inference about any candidate.
      </p>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* JD lexicon posture */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-neutral-900">JD language gate</h4>
            <Badge tone={enfMeta.tone}>{enfMeta.label}</Badge>
          </div>
          <p className="text-xs text-neutral-500">{enfMeta.blurb}</p>
          <div className="mt-4 flex items-center gap-2">
            <Badge tone="neutral">{totalTerms} terms</Badge>
            {totalBlock > 0 ? <Badge tone="error">{totalBlock} block</Badge> : null}
          </div>
          <div className="mt-4 space-y-2">
            {BIAS_CATEGORIES.map((c) => {
              const n = byCategory[c];
              return (
                <div key={c} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-neutral-600">{BIAS_CATEGORY_META[c].label}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="tabular-nums text-neutral-500">{n.warn} warn</span>
                    {n.block > 0 ? (
                      <span className="tabular-nums text-status-error-600">{n.block} block</span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
          <a
            href="/admin/ai-settings"
            className="mt-4 inline-block text-xs font-medium text-brand-600 hover:underline"
          >
            Manage the lexicon in AI settings →
          </a>
        </Card>

        {/* Blind screening posture */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-neutral-900">Blind screening posture</h4>
            <Badge tone="info">Text-based</Badge>
          </div>
          <p className="text-xs leading-relaxed text-neutral-600">
            AI screening reads the CV and the requisition’s skills and knockouts — it scores against
            the job, not the person. There is no photo analysis, no name-based inference, and no
            demographic signal in the pipeline. PII masking is an admin switch, and every candidate
            PII access is itself logged to the audit trail.
          </p>
          <ul className="mt-4 space-y-2 text-xs text-neutral-700">
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-0.5 text-status-positive-500">
                ✓
              </span>
              Scores explain themselves with real top-factors
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-0.5 text-status-positive-500">
                ✓
              </span>
              No sentiment or emotion inference on candidates
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-0.5 text-status-positive-500">
                ✓
              </span>
              Panel feedback hides prior scores to prevent anchoring
            </li>
          </ul>
        </Card>
      </div>

      <p className="text-xs text-neutral-400">
        The lexicon shown reflects this tenant’s live configuration. This screen is read-only; the
        gate is configured on Admin → AI settings.
      </p>
    </div>
  );
}
