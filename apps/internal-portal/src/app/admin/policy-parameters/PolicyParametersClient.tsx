"use client";

import { useState, type ReactNode } from "react";
import type { z } from "zod";
import {
  AI_INTERVIEW_POLICY_GUARDRAILS,
  APPLY_ACCEPTING_STATUS_OPTIONS,
  DEDUP_MATCH_MODES,
  DOCUMENT_FILE_KINDS,
  MARKET_INTEL_POLICY_GUARDRAILS,
  OFFER_POLICY_GUARDRAILS,
  REPORT_HIRE_EVENTS,
  REPORT_POLICY_GUARDRAILS,
  REPORT_TTF_ENDS,
  REPORT_TTF_STARTS,
  REQ_HEALTH_WEIGHT_KEYS,
  RESUME_FILE_KINDS,
  SALARY_RISK_RULES,
  SCREENING_POLICY_GUARDRAILS,
  aiInterviewPolicyWriteSchema,
  bulkCvUploadLimitsSchema,
  marketIntelPolicyWriteSchema,
  notetakerPolicyWriteSchema,
  offerPolicyWriteSchema,
  reportPolicyWriteSchema,
  screeningPolicyWriteSchema,
  uploadPolicyWriteSchema,
  type GetPolicyParametersOutput,
  type PolicyParameterBlockKey,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * C2-F7 — one card per policy block. Each card validates its draft with the
 * SAME strict write schema the API uses, so an out-of-range value is caught
 * here with the API's own message, and saves only its block.
 */

type Data = GetPolicyParametersOutput;
type Editable = Exclude<keyof Data, "platform">;

const SCHEMAS: Record<Editable, z.ZodTypeAny> = {
  screeningPolicy: screeningPolicyWriteSchema,
  uploadPolicy: uploadPolicyWriteSchema,
  offerPolicy: offerPolicyWriteSchema,
  aiInterviewPolicy: aiInterviewPolicyWriteSchema,
  notetakerPolicy: notetakerPolicyWriteSchema,
  reportPolicy: reportPolicyWriteSchema,
  marketIntelPolicy: marketIntelPolicyWriteSchema,
  bulkCvUpload: bulkCvUploadLimitsSchema,
};

const MB = 1024 * 1024;

const LABELS: Record<string, string> = {
  over_band_max: "Expected salary above the band maximum",
  over_compa_ratio: "Expected salary above a % of the band midpoint (compa-ratio)",
  email_or_phone: "Email or phone matches (default)",
  email: "Email only",
  phone: "Phone only",
  email_and_phone: "Both email and phone match the same person",
  approved: "Approved",
  posted: "Posted",
  offer_accepted: "Offer accepted",
  joined: "Joined (actual start date recorded)",
  application_created: "Application created",
  requisition_approved: "Requisition approved",
  jd: "Job description",
  skills: "Skills & weights",
  mustHaves: "Must-have skills",
  interviewPlan: "Interview plan",
  budget: "Budget band",
  approval: "Approval",
  pipeline: "Pipeline",
  pdf: "PDF",
  docx: "Word (.docx)",
  jpeg: "JPEG",
  png: "PNG",
};

function range(g: { min: number; max: number; default: number }, unit = ""): string {
  return `${g.min}–${g.max}${unit}. Platform default ${g.default}${unit}.`;
}

function NumberField(props: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  hint?: string;
  suffix?: string;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <Input
      type="number"
      size="sm"
      label={props.label}
      step={props.step ?? 1}
      suffix={props.suffix}
      hint={props.hint}
      value={Number.isFinite(props.value) ? String(props.value) : ""}
      onChange={(ev) => props.onChange(Number(ev.currentTarget.value))}
      disabled={props.disabled}
    />
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-neutral-700">{props.label}</span>
      <select
        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
        value={props.value}
        onChange={(ev) => props.onChange(ev.currentTarget.value as T)}
        disabled={props.disabled}
      >
        {props.options.map((o) => (
          <option key={o} value={o}>
            {LABELS[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckList<T extends string>(props: {
  label: string;
  value: readonly T[];
  options: readonly T[];
  onChange: (v: T[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="text-sm">
      <legend className="mb-1 font-medium text-neutral-700">{props.label}</legend>
      <div className="flex flex-wrap gap-4">
        {props.options.map((o) => (
          <label key={o} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={props.value.includes(o)}
              disabled={props.disabled}
              onChange={(ev) =>
                props.onChange(
                  ev.currentTarget.checked
                    ? props.options.filter((x) => x === o || props.value.includes(x))
                    : props.value.filter((x) => x !== o),
                )
              }
            />
            {LABELS[o] ?? o}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Section<K extends Editable>(props: {
  block: K;
  title: string;
  description: ReactNode;
  initial: Data[K];
  children: (draft: Data[K], set: (patch: Partial<Data[K]>) => void, busy: boolean) => ReactNode;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<Data[K]>(props.initial);
  const [saved, setSaved] = useState<Data[K]>(props.initial);
  const [notice, setNotice] = useState<string | null>(null);
  const update = trpc.updatePolicyParameters.useMutation({
    onSuccess: async () => {
      await utils.getPolicyParameters.invalidate();
      setSaved(draft);
      setNotice("Saved.");
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });
  const parsed = SCHEMAS[props.block].safeParse(draft);
  const error = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Invalid value");
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const busy = update.isPending;

  return (
    <Card className="mt-6 p-6">
      <h2 className="text-base font-semibold text-neutral-900">{props.title}</h2>
      <div className="mt-1 text-sm text-neutral-600">{props.description}</div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {props.children(draft, (patch) => setDraft((d) => ({ ...d, ...patch })), busy)}
      </div>
      {error ? <p className="mt-3 text-sm text-status-error-700">{error}</p> : null}
      {notice ? (
        <p
          className={`mt-3 text-sm ${notice.startsWith("Save failed") ? "text-status-error-700" : "text-status-success-700"}`}
        >
          {notice}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-3">
        <Button
          type="button"
          disabled={busy || !!error || !dirty}
          onClick={() => {
            if (!parsed.success) return;
            setNotice(null);
            update.mutate({
              block: props.block as PolicyParameterBlockKey,
              value: parsed.data,
            } as Parameters<typeof update.mutate>[0]);
          }}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

export function PolicyParametersClient({ initial }: { initial: Data }) {
  const S = SCREENING_POLICY_GUARDRAILS;
  const O = OFFER_POLICY_GUARDRAILS;
  const A = AI_INTERVIEW_POLICY_GUARDRAILS;
  const R = REPORT_POLICY_GUARDRAILS;
  const docCeilingMb = initial.platform.documentCeilingBytes / MB;
  const mediaCeilingMb = Math.floor(initial.platform.mediaCeilingBytes / MB);

  return (
    <PageContainer variant="measure" className="py-8">
      <PageHeader
        title="Policy parameters"
        subtitle="The numbers behind screening, uploads, offers, AI interviews, the notetaker and reports. Each has a platform default and a platform limit; you can change it within that limit. Every change is audited."
      />

      <Section
        block="screeningPolicy"
        title="Screening & applications"
        description="Risk flags on the shortlist, the requisition health score, AI scoring inputs, duplicate detection and which requisitions accept applications."
        initial={initial.screeningPolicy}
      >
        {(d, set, busy) => (
          <>
            <NumberField
              label="Skill-gap flag: must-have match at or below"
              suffix="%"
              value={d.riskSkillMismatchMaxPct}
              onChange={(n) => set({ riskSkillMismatchMaxPct: n })}
              hint={range(S.riskSkillMismatchMaxPct, "%")}
              disabled={busy}
            />
            <SelectField
              label="Salary-gap flag rule"
              value={d.riskSalaryRule}
              options={SALARY_RISK_RULES}
              onChange={(v) => set({ riskSalaryRule: v })}
              disabled={busy}
            />
            <NumberField
              label="Compa-ratio threshold (compa-ratio rule only)"
              suffix="%"
              value={d.riskSalaryCompaRatioPct}
              onChange={(n) => set({ riskSalaryCompaRatioPct: n })}
              hint={range(S.riskSalaryCompaRatioPct, "%")}
              disabled={busy}
            />
            <NumberField
              label="Skip AI scoring when CV parse confidence is below"
              step={0.05}
              value={d.parserConfidenceFloor}
              onChange={(n) => set({ parserConfidenceFloor: n })}
              hint={range(S.parserConfidenceFloor)}
              disabled={busy}
            />
            <NumberField
              label="Job description characters sent for scoring"
              suffix="chars"
              step={500}
              value={d.jdCharCap}
              onChange={(n) => set({ jdCharCap: n })}
              hint={range(S.jdCharCap)}
              disabled={busy}
            />
            <SelectField
              label="Same person when"
              value={d.dedupMatchOn}
              options={DEDUP_MATCH_MODES}
              onChange={(v) => set({ dedupMatchOn: v })}
              disabled={busy}
            />
            <NumberField
              label="Re-apply cooling-off after a rejection"
              suffix="days"
              value={d.reapplyCoolingOffDays}
              onChange={(n) => set({ reapplyCoolingOffDays: n })}
              hint={`${range(S.reapplyCoolingOffDays, " days")} 0 = off. Applies to the apply form and partner submissions.`}
              disabled={busy}
            />
            <CheckList
              label="Requisition statuses that accept applications"
              value={d.acceptingStatuses}
              options={APPLY_ACCEPTING_STATUS_OPTIONS}
              onChange={(v) => set({ acceptingStatuses: v })}
              disabled={busy}
            />
            <div className="sm:col-span-2">
              <p className="mb-2 text-sm font-medium text-neutral-700">
                Requisition health weights (must total 100)
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                {REQ_HEALTH_WEIGHT_KEYS.map((k) => (
                  <NumberField
                    key={k}
                    label={LABELS[k] ?? k}
                    suffix="pts"
                    value={d.reqHealthWeights[k]}
                    onChange={(n) => set({ reqHealthWeights: { ...d.reqHealthWeights, [k]: n } })}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </Section>

      <Section
        block="uploadPolicy"
        title="Uploads"
        description={`Per-file limits for CVs, documents and interview audio. You can lower the platform limits (documents ${docCeilingMb} MB, audio ${mediaCeilingMb} MB on this deployment) but not raise them.`}
        initial={initial.uploadPolicy}
      >
        {(d, set, busy) => (
          <>
            <NumberField
              label="CV / document size limit"
              suffix="MB"
              value={Math.round((d.maxDocumentBytes / MB) * 10) / 10}
              onChange={(n) => set({ maxDocumentBytes: Math.round(n * MB) })}
              hint={`1–${docCeilingMb} MB.`}
              disabled={busy}
            />
            <NumberField
              label="Interview audio size limit (blank = platform limit)"
              suffix="MB"
              value={d.maxMediaBytes == null ? Number.NaN : Math.round(d.maxMediaBytes / MB)}
              onChange={(n) =>
                set({ maxMediaBytes: Number.isFinite(n) && n > 0 ? Math.round(n * MB) : null })
              }
              hint={`10–${mediaCeilingMb} MB.`}
              disabled={busy}
            />
            <CheckList
              label="CV file types"
              value={d.resumeTypes}
              options={RESUME_FILE_KINDS}
              onChange={(v) => set({ resumeTypes: v })}
              disabled={busy}
            />
            <CheckList
              label="Document file types"
              value={d.documentTypes}
              options={DOCUMENT_FILE_KINDS}
              onChange={(v) => set({ documentTypes: v })}
              disabled={busy}
            />
          </>
        )}
      </Section>

      <Section
        block="bulkCvUpload"
        title="Bulk CV upload"
        description="Caps on one bulk upload to a requisition. The per-file limit is the CV limit above."
        initial={initial.bulkCvUpload}
      >
        {(d, set, busy) => (
          <>
            <NumberField
              label="Files per upload"
              value={d.maxFilesPerBatch}
              onChange={(n) => set({ maxFilesPerBatch: n })}
              hint="1–2000. Platform default 500."
              disabled={busy}
            />
            <NumberField
              label="Total size per upload"
              suffix="MB"
              value={Math.round(d.maxBatchBytes / MB)}
              onChange={(n) => set({ maxBatchBytes: Math.round(n * MB) })}
              hint="1–1024 MB. Platform default 200 MB."
              disabled={busy}
            />
          </>
        )}
      </Section>

      <Section
        block="offerPolicy"
        title="Offers"
        description="Defaults the offer forms start from, and the offer-decision target on the executive audit."
        initial={initial.offerPolicy}
      >
        {(d, set, busy) => (
          <>
            <NumberField
              label="Offer expiry"
              suffix="days"
              value={d.defaultExpiryDays}
              onChange={(n) => set({ defaultExpiryDays: n })}
              hint={range(O.defaultExpiryDays, " days")}
              disabled={busy}
            />
            <NumberField
              label="Probation"
              suffix="months"
              value={d.defaultProbationMonths}
              onChange={(n) => set({ defaultProbationMonths: n })}
              hint={range(O.defaultProbationMonths, " months")}
              disabled={busy}
            />
            <NumberField
              label="Offer decision target"
              suffix="hours"
              value={d.decisionSlaHours}
              onChange={(n) => set({ decisionSlaHours: n })}
              hint={range(O.decisionSlaHours, " h")}
              disabled={busy}
            />
          </>
        )}
      </Section>

      <Section
        block="aiInterviewPolicy"
        title="AI first-round interview"
        description="Link lifetime and how many questions a round has. The platform keeps every round between 5 and 10 questions."
        initial={initial.aiInterviewPolicy}
      >
        {(d, set, busy) => (
          <>
            <NumberField
              label="Link expiry"
              suffix="days"
              value={d.linkExpiryDays}
              onChange={(n) => set({ linkExpiryDays: n })}
              hint={range(A.linkExpiryDays, " days")}
              disabled={busy}
            />
            <div className="text-sm">
              <span className="mb-1 block font-medium text-neutral-700">Interview language</span>
              <Badge tone="neutral">English</Badge>
              <p className="mt-1 text-xs text-neutral-500">
                Question generation supports English only today.
              </p>
            </div>
            <NumberField
              label="Minimum questions"
              value={d.questionCountMin}
              onChange={(n) => set({ questionCountMin: n })}
              hint={range(A.questionCountMin)}
              disabled={busy}
            />
            <NumberField
              label="Maximum questions"
              value={d.questionCountMax}
              onChange={(n) => set({ questionCountMax: n })}
              hint={range(A.questionCountMax)}
              disabled={busy}
            />
          </>
        )}
      </Section>

      <Section
        block="notetakerPolicy"
        title="Interview notetaker"
        description="Words the speech model should spell your way (process names, systems, acronyms), sent with every recording after the interview's own names. The transcription provider and data region are platform settings."
        initial={initial.notetakerPolicy}
      >
        {(d, set, busy) => (
          <>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-neutral-700">
                Glossary (one term per line, up to 50, six words each)
              </span>
              <textarea
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                rows={6}
                value={d.keyterms.join("\n")}
                onChange={(ev) =>
                  set({
                    keyterms: ev.currentTarget.value
                      .split("\n")
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                disabled={busy}
              />
            </label>
            <div className="text-sm">
              <span className="mb-1 block font-medium text-neutral-700">
                Transcription language
              </span>
              <Badge tone="neutral">English</Badge>
            </div>
          </>
        )}
      </Section>

      <Section
        block="reportPolicy"
        title="Report definitions"
        description="What counts as a hire and how time to fill is measured, in every report and in Ask your data. Changing these changes published numbers."
        initial={initial.reportPolicy}
      >
        {(d, set, busy) => (
          <>
            <SelectField
              label="A hire is"
              value={d.hireEvent}
              options={REPORT_HIRE_EVENTS}
              onChange={(v) => set({ hireEvent: v })}
              disabled={busy}
            />
            <SelectField
              label="Time to fill starts at"
              value={d.ttfStart}
              options={REPORT_TTF_STARTS}
              onChange={(v) => set({ ttfStart: v })}
              disabled={busy}
            />
            <SelectField
              label="Time to fill ends at"
              value={d.ttfEnd}
              options={REPORT_TTF_ENDS}
              onChange={(v) => set({ ttfEnd: v })}
              disabled={busy}
            />
            <NumberField
              label="Onboarding 'starting soon' window"
              suffix="days"
              value={d.onboardingWindowDays}
              onChange={(n) => set({ onboardingWindowDays: n })}
              hint={range(R.onboardingWindowDays, " days")}
              disabled={busy}
            />
            <NumberField
              label="Requisition aging: rows listed"
              value={d.requisitionAgingRowCap}
              onChange={(n) => set({ requisitionAgingRowCap: n })}
              hint={range(R.requisitionAgingRowCap)}
              disabled={busy}
            />
            <NumberField
              label="Onboarding readiness: rows listed"
              value={d.onboardingRowCap}
              onChange={(n) => set({ onboardingRowCap: n })}
              hint={range(R.onboardingRowCap)}
              disabled={busy}
            />
          </>
        )}
      </Section>

      <Section
        block="marketIntelPolicy"
        title="Market intelligence"
        description="When a requisition's budget is flagged as below market on the governance and HR-head views."
        initial={initial.marketIntelPolicy}
      >
        {(d, set, busy) => (
          <NumberField
            label="Flag when the band maximum is below this share of the market median"
            step={0.05}
            value={d.gapThreshold}
            onChange={(n) => set({ gapThreshold: n })}
            hint={range(MARKET_INTEL_POLICY_GUARDRAILS.gapThreshold)}
            disabled={busy}
          />
        )}
      </Section>

      <Card className="mt-6 p-6">
        <h2 className="text-base font-semibold text-neutral-900">AI provider</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Set by your HireOps platform operator. Models per AI feature are chosen under AI settings.
        </p>
        <div className="mt-3">
          <Badge tone="neutral">{initial.platform.aiProvider}</Badge>
        </div>
      </Card>
    </PageContainer>
  );
}
