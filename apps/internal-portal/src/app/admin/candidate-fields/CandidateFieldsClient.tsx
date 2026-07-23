"use client";

import { useState } from "react";
import type {
  ApplicationStage,
  CandidateFieldPolicyEntry,
  GetCandidateFieldPolicyOutput,
  MissingInfoRequiredness,
} from "@hireops/api-types";
import { Select, Switch } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Candidate fields editor (T2.1 / G05) — the required-candidate-field policy.
 *
 * A table of the SEVEN code-owned catalog fields + their data source, each with a
 * requiredness toggle and a "blocks advancement to <stage>" select. Everything is
 * REAL config: the tenant's saved policy drives the recruiter's Missing Info
 * tracker AND the server-side advance gate.
 *
 * HONESTY — the catalog is code-owned (you configure it, you never invent
 * fields), and "Blocks advancement" is a genuine gate: a required field that is
 * missing refuses the candidate's forward move to that stage. An optional field
 * never gates, so its gate select is disabled.
 */

const NONE = "__none__";

// The stages a gate may sensibly point at — the forward pipeline stages. Missing
// info gates candidacy at eligibility (tech_interview) and offer prerequisites
// (offer_drafted) by default; the full set is offered for flexibility.
const GATE_STAGE_OPTIONS: { value: ApplicationStage; label: string }[] = [
  { value: "shortlisted", label: "Shortlist" },
  { value: "tech_interview", label: "Technical interview" },
  { value: "hr_round", label: "HR round" },
  { value: "offer_drafted", label: "Offer" },
  { value: "offer_accepted", label: "Offer accepted" },
];

function stageLabel(stage: ApplicationStage | null): string {
  if (stage === null) return "Doesn't gate";
  return GATE_STAGE_OPTIONS.find((o) => o.value === stage)?.label ?? stage.replace(/_/g, " ");
}

export function CandidateFieldsClient({ initial }: { initial: GetCandidateFieldPolicyOutput }) {
  const query = trpc.getCandidateFieldPolicy.useQuery(undefined, { initialData: initial });
  const fields = query.data?.fields ?? [];

  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const upsert = trpc.upsertCandidateFieldPolicy.useMutation({
    onSuccess: async (res) => {
      await query.refetch();
      setNotice(`Saved policy for “${res.field.label}”.`);
      setSavingKey(null);
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      setSavingKey(null);
      handleTRPCError(err);
    },
  });

  const reset = trpc.resetCandidateFieldPolicy.useMutation({
    onSuccess: async (res) => {
      await query.refetch();
      setNotice(`“${res.field.label}” reset to the platform default.`);
      setSavingKey(null);
    },
    onError: (err) => {
      setNotice(`Reset failed: ${err.message}`);
      setSavingKey(null);
      handleTRPCError(err);
    },
  });

  function saveRequiredness(field: CandidateFieldPolicyEntry, next: MissingInfoRequiredness) {
    setSavingKey(field.fieldKey);
    setNotice(null);
    // An optional field never gates — drop any gate when relaxing to optional.
    const blocksAdvanceStage = next === "optional" ? null : field.blocksAdvanceStage;
    upsert.mutate({ fieldKey: field.fieldKey, requiredness: next, blocksAdvanceStage });
  }

  function saveGate(field: CandidateFieldPolicyEntry, nextStage: ApplicationStage | null) {
    setSavingKey(field.fieldKey);
    setNotice(null);
    upsert.mutate({
      fieldKey: field.fieldKey,
      requiredness: field.requiredness,
      blocksAdvanceStage: nextStage,
    });
  }

  function resetField(field: CandidateFieldPolicyEntry) {
    setSavingKey(field.fieldKey);
    setNotice(null);
    reset.mutate({ fieldKey: field.fieldKey });
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Candidate fields"
        subtitle="Choose which of the seven tracked candidate-data fields this tenant requires, and what a missing required field blocks. Drives the recruiter's Missing Info tracker and the advancement gate."
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

      {/* Honesty banner — catalog vs invention, tracked vs gated. */}
      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        Only these seven data-backed fields are trackable — each reads from a real
        application/resume source, so the catalog is fixed (you configure it, you can&apos;t invent
        new fields). <span className="font-medium">Blocks advancement</span> is a real gate: a
        required field that is still missing refuses the candidate&apos;s forward move to that
        stage. An optional field is tracked in the recruiter&apos;s Missing Info view but never
        blocks.
      </div>

      <Card className="mt-6 overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50/60 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              <th className="px-4 py-2.5">Field</th>
              <th className="px-4 py-2.5">Data source</th>
              <th className="px-4 py-2.5">Required</th>
              <th className="px-4 py-2.5">Blocks advancement</th>
              <th className="px-4 py-2.5 text-right">Default</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => {
              const isRequired = field.requiredness === "required";
              const busy = savingKey === field.fieldKey && (upsert.isPending || reset.isPending);
              const differsFromDefault =
                field.requiredness !== field.defaultRequiredness ||
                field.blocksAdvanceStage !== field.defaultBlocksAdvanceStage;
              return (
                <tr key={field.fieldKey} className="border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-neutral-900">{field.label}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
                        {field.fieldKey}
                      </code>
                      {field.isConfigured ? (
                        <span className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                          Tenant policy
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                          Default
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-neutral-500">{field.dataSource}</code>
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={isRequired}
                      onCheckedChange={(next) =>
                        saveRequiredness(field, next ? "required" : "optional")
                      }
                      disabled={busy}
                      label={isRequired ? "Required" : "Optional"}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {isRequired ? (
                      <Select
                        options={[{ value: NONE, label: "Doesn't gate" }, ...GATE_STAGE_OPTIONS]}
                        value={field.blocksAdvanceStage ?? NONE}
                        onValueChange={(v) =>
                          saveGate(field, v === NONE ? null : (v as ApplicationStage))
                        }
                        disabled={busy}
                      />
                    ) : (
                      <span className="text-xs text-neutral-400">
                        Optional — tracked, never gates
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-xs text-neutral-500">
                      {field.defaultRequiredness === "required" ? "Required" : "Optional"}
                      {field.defaultBlocksAdvanceStage
                        ? ` · ${stageLabel(field.defaultBlocksAdvanceStage)}`
                        : ""}
                    </div>
                    {field.isConfigured && differsFromDefault ? (
                      <button
                        type="button"
                        onClick={() => resetField(field)}
                        disabled={busy}
                        className="mt-1 text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
                      >
                        Reset to default
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
