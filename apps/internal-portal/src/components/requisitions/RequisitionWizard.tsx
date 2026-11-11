"use client";

import { PageContainer } from "@/components/nav/PageContainer";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  summarizeScan,
  scanBlocksSubmit,
  type JdSections,
  type JdBiasScan,
  type RequisitionLocationType,
  type RequisitionKnockoutInput,
  KNOCKOUT_FIELD_CATALOGUE,
  knockoutFieldDef,
  compBandsForScope,
  jobProfilePrefill,
  locationDisplay,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button, Card } from "@/components/ui";
import { InterviewPlanSection } from "@/components/interviews/InterviewPlanSection";
import { JdEditor } from "./JdEditor";
import { SkillWeightsEditor, newSkillRow, type SkillWeightRow } from "./SkillWeightsEditor";
import type { RoleTemplate } from "./requisition-templates";
import type { JdSectionKey } from "@hireops/api-types";

/**
 * RO-02 — the requisition creation wizard v2. FIVE honest steps, restructured
 * from the REQ-02 four-step wizard (RO-01/RO-03 do not touch this file):
 *
 *   1. Role basics        — fields + a curated "Quick start" role-template row.
 *   2. Job description     — per-section editor cards (JdEditor) + a quality
 *                            strip (completeness / readability / real bias scan)
 *                            + AI generate/regenerate (the real generateJdDraft).
 *   3. Skill weighting     — SkillWeightsEditor (weights + scoring impact copy
 *                            that truthfully describes the real engine) + the
 *                            real knockouts UI (hard gates).
 *   4. Interview rounds     — the existing InterviewPlanSection plan editor,
 *                            embedded (rounds / mode / scorecard / competency
 *                            focus / default panel) — not forked.
 *   5. Review & submit      — a red/green submission checklist (each item links
 *                            back to its step) + full summary + submit.
 *
 * Draft persistence is server-side via the REQ-02 mutations; the URL carries
 * ?rid= and ?step= so a reload (or the seeded mid-wizard demo draft) resumes
 * exactly where the requirement owner left off. The wizard hydrates from
 * getRequisitionDetail when it opens on an existing draft.
 */

type Step = 1 | 2 | 3 | 4 | 5;
const STEP_LABELS = [
  "Role basics",
  "Job description",
  "Skill weighting",
  "Interview rounds",
  "Review",
];

const LOCATION_TYPES: RequisitionLocationType[] = ["onsite", "hybrid", "remote", "multi"];
const KNOCKOUT_TYPES: RequisitionKnockoutInput["type"][] = [
  "boolean",
  "numeric_min",
  "numeric_max",
  "enum",
];

// Human labels for the knockout rule type — HR should never see the raw enum
// ("numeric_min", "enum"). The label describes the check in plain terms.
const KNOCKOUT_TYPE_LABELS: Record<RequisitionKnockoutInput["type"], string> = {
  boolean: "Must be present",
  numeric_min: "At least (minimum)",
  numeric_max: "At most (maximum)",
  enum: "One of allowed values",
};

// The fields a knockout can check, with human labels — straight from the
// platform default catalogue (@hireops/api-types KNOCKOUT_FIELD_CATALOGUE). HR
// picks a field instead of typing a machine path; the stored value is the raw
// path the evaluator resolves. PC-7 added the screening-answer fields (notice
// period, expected CTC, current location) — those read the application's
// answers, and a missing answer is "unknown", never a fail. "Other (advanced)"
// reveals a free-text input for the long tail of parsed-CV paths.
const KNOCKOUT_FIELD_OPTIONS: { value: string; label: string }[] = KNOCKOUT_FIELD_CATALOGUE.map(
  (f) => ({
    value: f.fieldPath,
    label: f.source === "parsed_cv" ? f.label : `${f.label} (screening answer)`,
  }),
);
const KNOCKOUT_FIELD_OTHER = "__other__";

interface BasicsState {
  title: string;
  /** T3.1 / G14 — the CONTROLLED business_unit id the picker sends. */
  businessUnitId: string;
  /** The selected unit's display NAME — kept for the review row + draft resume. */
  department: string;
  locationType: RequisitionLocationType;
  primaryLocation: string;
  seniority: string;
  employmentType: string;
  numberOfOpenings: number;
  targetStartDate: string;
  /** T3.2 / G15 — the CONTROLLED comp-band id the picker sends. Empty = manual /
   * template entry (no band; comp columns come from the typed values). */
  compBandId: string;
  compBandMin: string; // INR annual, as string for the input
  compBandMax: string;
  /** C1-F3 — structured job architecture + organisation (empty = not picked). */
  jobProfileId: string;
  jobFunctionId: string;
  jobLevelId: string;
  /** A managed location id; empty = the free-text primaryLocation fallback. */
  locationId: string;
  /** Tenant-lookup keys (employment_type / requisition_type). */
  employmentTypeKey: string;
  requisitionTypeKey: string;
}

/** Location picker sentinel: "type a location instead". */
const LOCATION_OTHER = "__other__";

const EMPTY_BASICS: BasicsState = {
  title: "",
  businessUnitId: "",
  department: "",
  locationType: "onsite",
  primaryLocation: "",
  seniority: "",
  employmentType: "",
  numberOfOpenings: 1,
  targetStartDate: "",
  compBandId: "",
  compBandMin: "",
  compBandMax: "",
  jobProfileId: "",
  jobFunctionId: "",
  jobLevelId: "",
  locationId: "",
  employmentTypeKey: "",
  requisitionTypeKey: "",
};

const EMPTY_SECTIONS: JdSections = {
  summary: "",
  responsibilities: [],
  requirements: [],
  niceToHave: [],
  toolsTech: [],
  education: [],
  softSkills: [],
};

interface KnockoutRow {
  key: string;
  questionText: string;
  type: RequisitionKnockoutInput["type"];
  fieldPath: string;
  value: string;
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
const labelCls = "block text-xs font-medium text-neutral-700 mb-1";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

export function RequisitionWizard({
  initialRid,
  isAdmin = false,
}: {
  initialRid: string | null;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialStep = ((): Step => {
    const s = Number(searchParams.get("step"));
    if (initialRid && s >= 1 && s <= 5) return s as Step;
    return initialRid ? 2 : 1;
  })();

  const [rid, setRid] = useState<string | null>(initialRid);
  const [step, setStep] = useState<Step>(initialStep);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(!initialRid);

  const [basics, setBasics] = useState<BasicsState>(EMPTY_BASICS);
  const [sections, setSections] = useState<JdSections>(EMPTY_SECTIONS);
  const [extraContext, setExtraContext] = useState("");
  const [skills, setSkills] = useState<SkillWeightRow[]>([]);
  const [knockouts, setKnockouts] = useState<KnockoutRow[]>([]);
  const [generatingTarget, setGeneratingTarget] = useState<JdSectionKey | "all" | null>(null);
  // PC-26 — diverse-slate requirement for this role. `min` "" = tenant default.
  const [diverseSlate, setDiverseSlate] = useState<{ required: boolean; min: string }>({
    required: false,
    min: "",
  });
  const diverseDefaultsQuery = trpc.getDiverseSlateDefaults.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const diverseDefaults = diverseDefaultsQuery.data;

  const createDraft = trpc.createRequisitionDraft.useMutation();
  const generateJd = trpc.generateJdDraft.useMutation();

  // T3.1 / G14 — the managed business-unit list drives the Basics picker. The
  // creator picks a unit id from this controlled, non-archived list; free text
  // is gone. Ordered by name (server-side).
  const businessUnitsQuery = trpc.listBusinessUnits.useQuery({});
  const businessUnits = useMemo(
    () => businessUnitsQuery.data?.rows ?? [],
    [businessUnitsQuery.data],
  );
  const noBusinessUnits = businessUnitsQuery.isSuccess && businessUnits.length === 0;

  // T3.2 / G15 — the managed comp-band library drives the Basics comp picker.
  // Picking a band POPULATES the min/max/currency (still editable) and records
  // the band id as provenance; the server copies the band's values onto the
  // position. Non-archived only. Optional: the manual-entry path stays.
  const compBandsQuery = trpc.listCompBands.useQuery({});
  const allCompBands = useMemo(() => compBandsQuery.data?.rows ?? [], [compBandsQuery.data]);
  const noCompBands = compBandsQuery.isSuccess && allCompBands.length === 0;

  // C1-F3 — the organisation + job architecture pickers (active rows only):
  // job profiles, functions, levels, locations and the employment / requisition
  // type lists (platform default + tenant value). Each picker only shows when
  // the tenant has defined values; otherwise the old free-text field stays.
  const archQuery = trpc.getOrgAndJobArchitecture.useQuery(
    {},
    { staleTime: 60_000, refetchOnWindowFocus: false, retry: false },
  );
  const arch = archQuery.data;
  const [locationOther, setLocationOther] = useState(false);
  const pickedProfile = useMemo(
    () => arch?.jobProfiles.find((p) => p.id === basics.jobProfileId) ?? null,
    [arch, basics.jobProfileId],
  );
  const levelOptions = useMemo(() => {
    if (!arch) return [];
    if (!pickedProfile) return arch.jobLevels;
    const allowed = new Set(jobProfilePrefill(pickedProfile, arch).allowedLevelIds);
    return arch.jobLevels.filter((l) => allowed.has(l.id));
  }, [arch, pickedProfile]);
  // Bands that apply to the picked level / function / location, most specific
  // first; with nothing picked, every band (the pre-C1-F3 list).
  const compBands = useMemo(() => {
    const scoped = basics.jobLevelId || basics.jobFunctionId || basics.locationId;
    if (!scoped) return allCompBands;
    return compBandsForScope(allCompBands, {
      jobLevelId: basics.jobLevelId || null,
      jobFunctionId: basics.jobFunctionId || null,
      locationId: basics.locationId || null,
    });
  }, [allCompBands, basics.jobLevelId, basics.jobFunctionId, basics.locationId]);
  const pickedBand = useMemo(
    () => compBands.find((b) => b.id === basics.compBandId) ?? null,
    [compBands, basics.compBandId],
  );

  // Resuming a draft: getRequisitionDetail returns the department NAME, not the
  // unit id — best-effort match it back to a managed unit so the picker shows
  // the current selection.
  useEffect(() => {
    if (businessUnits.length === 0) return;
    setBasics((b) => {
      if (b.businessUnitId || !b.department) return b;
      const match = businessUnits.find((u) => u.name === b.department);
      return match ? { ...b, businessUnitId: match.id } : b;
    });
  }, [businessUnits]);
  const updateDraft = trpc.updateRequisitionDraft.useMutation();
  const submit = trpc.submitRequisitionForApproval.useMutation();

  // T12/G11 — the Quick-start row reads the org's JD-template library
  // (jd_templates). No library rows (or loading / errored / FORBIDDEN for a
  // non-curator role) = no Quick-start row; `retry: false` keeps a FORBIDDEN
  // from spinning.
  const templatesQuery = trpc.listJdTemplates.useQuery(
    {},
    { staleTime: 60_000, refetchOnWindowFocus: false, retry: false },
  );
  const templates: RoleTemplate[] = useMemo(() => {
    const rows = templatesQuery.data?.items;
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      title: r.title,
      seniority: r.seniority,
      locationType: r.locationType,
      budgetMinInr: r.budgetMinInr,
      budgetMaxInr: r.budgetMaxInr,
      extraContext: r.extraContext,
      skills: r.skills.map((s) => ({
        skillName: s.skillName,
        category: s.category,
        weight: s.weight,
        isRequired: s.isRequired,
        minYears: s.minYears,
      })),
    }));
  }, [templatesQuery.data]);

  // Hydrate an existing draft (resume / seeded mid-wizard demo draft).
  const detailQuery = trpc.getRequisitionDetail.useQuery(
    { requisitionId: rid ?? "" },
    { enabled: !!initialRid && !hydrated },
  );
  useEffect(() => {
    if (hydrated || !detailQuery.data) return;
    const d = detailQuery.data;
    setBasics({
      title: d.title ?? "",
      businessUnitId: "",
      department: d.department ?? "",
      locationType: (d.locationType as RequisitionLocationType) ?? "onsite",
      primaryLocation: d.primaryLocation ?? "",
      seniority: d.seniority ?? "",
      employmentType: "",
      numberOfOpenings: d.numberOfOpenings,
      targetStartDate: d.targetStartDate ?? "",
      compBandId: "",
      compBandMin: d.compBandMin ?? "",
      compBandMax: d.compBandMax ?? "",
      jobProfileId: d.jobProfileId ?? "",
      jobFunctionId: d.jobFunctionId ?? "",
      jobLevelId: d.jobLevelId ?? "",
      locationId: d.locationId ?? "",
      employmentTypeKey: d.employmentTypeKey ?? "",
      requisitionTypeKey: d.requisitionTypeKey ?? "",
    });
    setDiverseSlate({
      required: d.diverseSlateRequired ?? false,
      min: d.diverseSlateMin != null ? String(d.diverseSlateMin) : "",
    });
    if (d.jdSections) {
      setSections({ ...EMPTY_SECTIONS, ...d.jdSections });
    }
    setSkills(
      d.skills.map((s) =>
        newSkillRow({
          skillName: s.skillName,
          category: s.category ?? "General",
          weight: s.weight,
          isRequired: s.isRequired,
          minYears: s.minYears ?? null,
          notes: s.notes ?? "",
        }),
      ),
    );
    setKnockouts(
      d.knockouts.map((k) => ({
        key: uid(),
        questionText: k.questionText,
        type: k.type as KnockoutRow["type"],
        fieldPath: knockoutFieldPath(k.thresholdValue),
        value: knockoutValueString(k.type as KnockoutRow["type"], k.thresholdValue),
      })),
    );
    setHydrated(true);
  }, [detailQuery.data, hydrated]);

  // CONF-02: live client-side bias scan over the composed JD (same scanner as
  // the submit gate). Feeds JdEditor's quality strip + the review checklist.
  const lexiconQuery = trpc.getBiasLexicon.useQuery({});
  const composedJd = useMemo(
    () =>
      [
        basics.title,
        sections.summary,
        ...sections.responsibilities,
        ...sections.requirements,
        ...sections.niceToHave,
        ...sections.toolsTech,
        ...sections.education,
        ...sections.softSkills,
      ]
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

  // Interview plan round count for the review checklist.
  const planQuery = trpc.getInterviewPlan.useQuery(
    { requisitionId: rid ?? "" },
    { enabled: !!rid },
  );
  const roundCount = planQuery.data?.rounds.length ?? 0;

  const busy =
    createDraft.isPending ||
    generateJd.isPending ||
    updateDraft.isPending ||
    submit.isPending ||
    generatingTarget !== null;

  function goToStep(next: Step) {
    setStep(next);
    if (rid) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("rid", rid);
      params.set("step", String(next));
      router.replace(`/requisitions/new?${params.toString()}`);
    }
  }
  function setRidInUrl(newRid: string, nextStep: Step) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("rid", newRid);
    params.set("step", String(nextStep));
    router.replace(`/requisitions/new?${params.toString()}`);
  }

  function applyTemplate(t: RoleTemplate) {
    setBasics((b) => ({
      ...b,
      title: t.title,
      seniority: t.seniority,
      locationType: t.locationType,
      // A JD-template prefill is a manual comp path — clear any picked band so
      // the template's budget isn't mislabelled as coming from a comp band.
      compBandId: "",
      compBandMin: String(t.budgetMinInr),
      compBandMax: String(t.budgetMaxInr),
    }));
    setExtraContext(t.extraContext);
    setSkills(
      t.skills.map((s) =>
        newSkillRow({
          skillName: s.skillName,
          category: s.category,
          weight: Math.round(s.weight),
          isRequired: s.isRequired ?? true,
          minYears: s.minYears ?? null,
        }),
      ),
    );
  }

  /**
   * C1-F3 — picking a job profile pre-fills title, function, level (the
   * range's lower bound), the free-text seniority and, when the skill list is
   * still empty, the profile's competencies as skills. Everything stays
   * editable; the requisition keeps the profile as provenance.
   */
  function applyProfile(profileId: string) {
    const profile = arch?.jobProfiles.find((p) => p.id === profileId);
    if (!arch || !profile) {
      setBasics((b) => ({ ...b, jobProfileId: "" }));
      return;
    }
    const pre = jobProfilePrefill(profile, arch);
    setBasics((b) => ({
      ...b,
      jobProfileId: pre.jobProfileId,
      title: pre.title,
      jobFunctionId: pre.jobFunctionId ?? "",
      jobLevelId: pre.jobLevelId ?? "",
      seniority: pre.seniorityLabel ?? b.seniority,
    }));
    if (pre.competencies.length > 0) {
      setSkills((current) =>
        current.some((s) => s.skillName.trim())
          ? current
          : pre.competencies.map((c) =>
              newSkillRow({
                skillName: c.label,
                category: "Competencies",
                weight: 1,
                isRequired: false,
                minYears: null,
              }),
            ),
      );
    }
  }

  async function onCreateBasics() {
    setError(null);
    try {
      const res = await createDraft.mutateAsync({
        title: basics.title,
        businessUnitId: basics.businessUnitId,
        locationType: basics.locationType,
        primaryLocation: basics.primaryLocation || undefined,
        seniority: basics.seniority || undefined,
        employmentType: basics.employmentType || undefined,
        // C1-F3 — structured fields; the server validates each against the
        // tenant's active rows and fills the free-text fallbacks.
        jobProfileId: basics.jobProfileId || undefined,
        jobFunctionId: basics.jobFunctionId || undefined,
        jobLevelId: basics.jobLevelId || undefined,
        locationId: basics.locationId || undefined,
        employmentTypeKey: basics.employmentTypeKey || undefined,
        requisitionTypeKey: basics.requisitionTypeKey || undefined,
        numberOfOpenings: basics.numberOfOpenings,
        targetStartDate: basics.targetStartDate || undefined,
        // T3.2 / G15 — send the picked band id as provenance. If the user left
        // the filled values untouched the server copies from the band; if they
        // edited them, the explicit values override yet the band id is retained.
        compBandId: basics.compBandId || undefined,
        compBandMin: basics.compBandMin ? Number(basics.compBandMin) : undefined,
        compBandMax: basics.compBandMax ? Number(basics.compBandMax) : undefined,
        compCurrency: basics.compBandMin || basics.compBandMax ? "INR" : undefined,
        ...diverseSlateInput(),
      });
      setRid(res.requisitionId);
      setRidInUrl(res.requisitionId, 2);
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onGenerateJd(target: JdSectionKey | "all") {
    if (!rid) return;
    setError(null);
    setGeneratingTarget(target);
    try {
      // Persist current sections first so a per-section regenerate doesn't lose
      // manual edits, then call the REAL generate path.
      await updateDraft.mutateAsync({ requisitionId: rid, sections });
      const res = await generateJd.mutateAsync({
        requisitionId: rid,
        extraContext: extraContext || undefined,
      });
      // The AI produces only the core three sections. "all" replaces all three;
      // a single key applies only that section (keeping the rest untouched).
      if (target === "all") {
        setSections((prev) => ({
          ...prev,
          summary: res.sections.summary,
          responsibilities: res.sections.responsibilities,
          requirements: res.sections.requirements,
        }));
      } else if (
        target === "summary" ||
        target === "responsibilities" ||
        target === "requirements"
      ) {
        setSections((prev) => ({ ...prev, [target]: res.sections[target] }));
      }
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    } finally {
      setGeneratingTarget(null);
    }
  }

  /** PC-26 — the role's diverse-slate fields as the draft mutations take them. */
  function diverseSlateInput(): { diverseSlateRequired: boolean; diverseSlateMin: number | null } {
    const n = Math.trunc(Number(diverseSlate.min));
    return {
      diverseSlateRequired: diverseSlate.required,
      diverseSlateMin:
        diverseSlate.required && diverseSlate.min.trim() && n >= 1 && n <= 20 ? n : null,
    };
  }

  async function onContinueFromBasics() {
    if (!rid) return;
    setError(null);
    try {
      await updateDraft.mutateAsync({ requisitionId: rid, ...diverseSlateInput() });
      goToStep(2);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function persistDraft() {
    if (!rid) return;
    await updateDraft.mutateAsync({
      requisitionId: rid,
      ...diverseSlateInput(),
      sections,
      skills: skills
        .filter((s) => s.skillName.trim().length > 0)
        .map((s) => ({
          skillName: s.skillName.trim(),
          weight: s.weight,
          isRequired: s.isRequired,
          category: s.category.trim() || null,
          minYears: s.minYears,
          notes: s.notes.trim() || null,
        })),
      knockouts: knockouts.map(toKnockoutInput),
    });
  }

  async function onSaveAndNext(next: Step) {
    if (!rid) return;
    setError(null);
    try {
      await persistDraft();
      goToStep(next);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onSubmit() {
    if (!rid) return;
    setError(null);
    try {
      await persistDraft();
      await submit.mutateAsync({ requisitionId: rid });
      router.push(`/requisitions/${rid}`);
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  // ─────────── review checklist (client guard; server enforces its own trio) ───────────
  const jdFilled = sections.summary.trim().length > 0 && sections.requirements.length > 0;
  const skillsFilled = skills.filter((s) => s.skillName.trim().length > 0).length > 0;
  const budgetFilled = basics.compBandMin.trim().length > 0 && basics.compBandMax.trim().length > 0;
  const biasBlocked = scan ? scanBlocksSubmit(scan) : false;
  const checklist: ChecklistItem[] = [
    { label: "Role title set", ok: basics.title.trim().length >= 2, step: 1 },
    { label: "Budget band set", ok: budgetFilled, step: 1 },
    {
      label: "Job description written",
      ok: jdFilled && !biasBlocked,
      step: 2,
      reason: biasBlocked
        ? "The JD contains blocked language, revise it in the JD step."
        : undefined,
    },
    { label: "At least one skill weighted", ok: skillsFilled, step: 3 },
    { label: "Interview rounds configured", ok: roundCount > 0, step: 4 },
  ];
  const allGreen = checklist.every((c) => c.ok);

  return (
    <PageContainer variant="measure" className="py-6">
      <Stepper step={step} onJump={(n) => (rid || n === 1 ? goToStep(n) : undefined)} rid={rid} />
      <AutosaveIndicator
        savedAt={updateDraft.data ? Date.now() : null}
        pending={updateDraft.isPending}
        hasRid={!!rid}
      />
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {/* ─────────── Step 1: Role basics ─────────── */}
      {step === 1 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">Role basics</h2>
          <p className="mb-4 text-sm text-neutral-600">
            Start from one of your organisation&rsquo;s role templates, or fill the fields directly.
            Everything stays editable.
          </p>

          {templates.length > 0 ? (
            <div className="mb-5">
              <p className="mb-2 text-xs font-medium text-neutral-700">
                Quick start, role templates{" "}
                <span className="font-normal text-neutral-400">
                  (curated presets, fully editable)
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            {arch && arch.jobProfiles.length > 0 ? (
              <div className="col-span-2">
                <Field label="Job profile (optional)">
                  <select
                    className={inputCls}
                    value={basics.jobProfileId}
                    onChange={(e) => applyProfile(e.target.value)}
                  >
                    <option value="">— None (fill the fields directly) —</option>
                    {arch.jobProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </Field>
                {pickedProfile ? (
                  <p className="mt-1 text-xs text-neutral-500">
                    Filled from the profile: title, function, level
                    {pickedProfile.competencies.length > 0
                      ? " and its competencies as skills (if none were set)"
                      : ""}
                    . Everything stays editable.
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="col-span-2">
              <Field label="Job title">
                <input
                  className={inputCls}
                  value={basics.title}
                  onChange={(e) => setBasics({ ...basics, title: e.target.value })}
                  placeholder="e.g. Accounts Payable Analyst"
                />
              </Field>
            </div>
            <Field label="Department / business unit">
              {noBusinessUnits ? (
                <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {isAdmin ? (
                    <>
                      No business units are defined yet.{" "}
                      <a href="/admin/business-units" className="font-medium underline">
                        Define your org&apos;s business units
                      </a>{" "}
                      before creating a requisition.
                    </>
                  ) : (
                    "No business units are defined yet. An administrator must define the org's business units before a requisition can be created."
                  )}
                </div>
              ) : (
                <select
                  className={inputCls}
                  value={basics.businessUnitId}
                  disabled={businessUnitsQuery.isLoading}
                  onChange={(e) => {
                    const id = e.target.value;
                    const unit = businessUnits.find((u) => u.id === id);
                    setBasics({ ...basics, businessUnitId: id, department: unit?.name ?? "" });
                  }}
                >
                  <option value="" disabled>
                    {businessUnitsQuery.isLoading ? "Loading units…" : "Select a business unit"}
                  </option>
                  {businessUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {arch && arch.jobLevels.length > 0 ? (
              <Field label="Level">
                <select
                  className={inputCls}
                  value={basics.jobLevelId}
                  onChange={(e) => {
                    const level = arch.jobLevels.find((l) => l.id === e.target.value);
                    setBasics({
                      ...basics,
                      jobLevelId: level?.id ?? "",
                      seniority: level?.label ?? "",
                      compBandId: "",
                    });
                  }}
                >
                  <option value="">— Select a level —</option>
                  {levelOptions.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label} ({l.key})
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Seniority">
                <input
                  className={inputCls}
                  value={basics.seniority}
                  onChange={(e) => setBasics({ ...basics, seniority: e.target.value })}
                  placeholder="e.g. Senior"
                />
              </Field>
            )}
            {arch && arch.jobFunctions.length > 0 ? (
              <Field label="Function">
                <select
                  className={inputCls}
                  value={basics.jobFunctionId}
                  onChange={(e) =>
                    setBasics({ ...basics, jobFunctionId: e.target.value, compBandId: "" })
                  }
                >
                  <option value="">— Select a function —</option>
                  {arch.jobFunctions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
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
              {arch && arch.locations.length > 0 ? (
                <>
                  <select
                    className={inputCls}
                    value={
                      basics.locationId ||
                      (locationOther || (basics.primaryLocation && !basics.locationId)
                        ? LOCATION_OTHER
                        : "")
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === LOCATION_OTHER) {
                        setLocationOther(true);
                        setBasics({ ...basics, locationId: "", compBandId: "" });
                        return;
                      }
                      setLocationOther(false);
                      const loc = arch.locations.find((l) => l.id === v);
                      setBasics({
                        ...basics,
                        locationId: loc?.id ?? "",
                        primaryLocation: loc?.name ?? "",
                        compBandId: "",
                      });
                    }}
                  >
                    <option value="">— Select a location —</option>
                    {arch.locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {locationDisplay(l)}
                      </option>
                    ))}
                    <option value={LOCATION_OTHER}>Other (type a location)</option>
                  </select>
                  {!basics.locationId && (locationOther || basics.primaryLocation) ? (
                    <input
                      className={`${inputCls} mt-2`}
                      value={basics.primaryLocation}
                      onChange={(e) => setBasics({ ...basics, primaryLocation: e.target.value })}
                      placeholder="City"
                      aria-label="Location (free text)"
                    />
                  ) : null}
                </>
              ) : (
                <input
                  className={inputCls}
                  value={basics.primaryLocation}
                  onChange={(e) => setBasics({ ...basics, primaryLocation: e.target.value })}
                  placeholder="City"
                />
              )}
            </Field>
            <Field label="Employment type">
              {arch ? (
                <select
                  className={inputCls}
                  value={basics.employmentTypeKey}
                  onChange={(e) => {
                    const entry = arch.lookups.employmentType.find((x) => x.key === e.target.value);
                    setBasics({
                      ...basics,
                      employmentTypeKey: entry?.key ?? "",
                      employmentType: entry?.label ?? "",
                    });
                  }}
                >
                  <option value="">— Select —</option>
                  {arch.lookups.employmentType.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputCls}
                  value={basics.employmentType}
                  onChange={(e) => setBasics({ ...basics, employmentType: e.target.value })}
                  placeholder="Full-time"
                />
              )}
            </Field>
            {arch ? (
              <Field label="Requisition type">
                <select
                  className={inputCls}
                  value={basics.requisitionTypeKey}
                  onChange={(e) => setBasics({ ...basics, requisitionTypeKey: e.target.value })}
                >
                  <option value="">— Select —</option>
                  {arch.lookups.requisitionType.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
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
            <div className="col-span-2">
              <Field label="Comp band (optional)">
                {noCompBands ? (
                  <div className="rounded-button border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                    {isAdmin ? (
                      <>
                        No comp bands are defined yet.{" "}
                        <a href="/admin/comp-bands" className="font-medium underline">
                          Add comp bands
                        </a>{" "}
                        to pick from a managed library, or enter the budget manually below.
                      </>
                    ) : (
                      "No comp bands are defined yet, enter the budget manually below, or ask an administrator to add a comp-band library."
                    )}
                  </div>
                ) : (
                  <select
                    className={inputCls}
                    value={basics.compBandId}
                    disabled={compBandsQuery.isLoading}
                    onChange={(e) => {
                      const id = e.target.value;
                      const band = compBands.find((b) => b.id === id);
                      if (band) {
                        // Picking a band fills the budget (still editable) and
                        // records the band as provenance.
                        setBasics({
                          ...basics,
                          compBandId: band.id,
                          compBandMin: String(band.minMajor),
                          compBandMax: String(band.maxMajor),
                        });
                      } else {
                        // "None" — manual entry; drop the provenance, keep typed values.
                        setBasics({ ...basics, compBandId: "" });
                      }
                    }}
                  >
                    <option value="">— None (enter budget manually) —</option>
                    {compBands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {b.level ? ` · ${b.level}` : ""} ({b.currency}{" "}
                        {b.minMajor.toLocaleString("en-IN")}–{b.maxMajor.toLocaleString("en-IN")})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <Field label="Budget band, min (INR / year)">
              <input
                type="number"
                min={0}
                className={inputCls}
                value={basics.compBandMin}
                onChange={(e) => setBasics({ ...basics, compBandMin: e.target.value })}
                placeholder="2800000"
              />
            </Field>
            <Field label="Budget band, max (INR / year)">
              <input
                type="number"
                min={0}
                className={inputCls}
                value={basics.compBandMax}
                onChange={(e) => setBasics({ ...basics, compBandMax: e.target.value })}
                placeholder="4200000"
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
          {/* PC-26 — diverse-slate requirement. Shown only when the tenant has
              the feature on (or this draft already carries the flag). Flags the
              role when its slate is short; never blocks a move or an offer. */}
          {diverseDefaults?.enabled || diverseSlate.required ? (
            <div className="mt-5 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
              <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
                <input
                  type="checkbox"
                  checked={diverseSlate.required}
                  onChange={(e) => setDiverseSlate({ ...diverseSlate, required: e.target.checked })}
                  className="h-4 w-4 rounded border-neutral-300 text-brand-600"
                />
                Diverse slate required
              </label>
              <p className="mt-1 text-xs text-neutral-500">
                Flags this role when fewer candidates in its slate (shortlist through offer) have
                self-identified as diverse than the minimum. A reminder only; it never blocks a move
                or an offer.
              </p>
              {diverseSlate.required ? (
                <div className="mt-3 max-w-xs">
                  <Field label="Minimum diverse candidates in slate">
                    <input
                      type="number"
                      min={1}
                      max={20}
                      className={inputCls}
                      value={diverseSlate.min}
                      onChange={(e) => setDiverseSlate({ ...diverseSlate, min: e.target.value })}
                      placeholder={`${diverseDefaults?.defaultMin ?? 2} (organisation default)`}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-6 flex justify-end">
            {rid ? (
              <Button onClick={() => void onContinueFromBasics()} disabled={busy}>
                Continue
              </Button>
            ) : (
              <Button
                onClick={onCreateBasics}
                disabled={busy || basics.title.trim().length < 2 || !basics.businessUnitId}
              >
                {createDraft.isPending ? "Creating…" : "Create draft & continue"}
              </Button>
            )}
          </div>
        </Card>
      ) : null}

      {/* ─────────── Step 2: Job description ─────────── */}
      {step === 2 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">Job description</h2>
          <p className="mb-4 text-sm text-neutral-600">
            Generate a first draft with AI, then edit any section. The quality strip updates live.
          </p>
          <JdEditor
            sections={sections}
            onChange={setSections}
            scan={scan}
            onGenerate={onGenerateJd}
            generatingTarget={generatingTarget}
            busy={busy}
            extraContext={extraContext}
            onExtraContextChange={setExtraContext}
          />
          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => goToStep(1)} disabled={busy}>
              Back
            </Button>
            <Button onClick={() => onSaveAndNext(3)} disabled={busy || !jdFilled}>
              {updateDraft.isPending ? "Saving…" : "Save & continue"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* ─────────── Step 3: Skill weighting ─────────── */}
      {step === 3 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">Skill weighting</h2>
          <p className="mb-4 text-sm text-neutral-600">
            Weight the skills the AI evaluator emphasises, then add any hard knockout gates.
          </p>
          <SkillWeightsEditor skills={skills} onChange={setSkills} />

          <div className="mt-8">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-neutral-900">Knockouts</h3>
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
            <p className="mb-3 text-xs text-neutral-500">
              Hard gates evaluated deterministically at apply time against the parsed CV or the
              candidate&rsquo;s screening answers. A candidate who fails is filtered out; a missing
              answer shows as &ldquo;unknown&rdquo;, not a fail. No AI involved.
            </p>
            {knockouts.length === 0 ? (
              <p className="text-xs text-neutral-500">
                Optional, e.g. &ldquo;≥ 5 years experience&rdquo;.
              </p>
            ) : (
              <div className="space-y-3">
                {knockouts.map((k) => {
                  const fieldIsKnown = KNOCKOUT_FIELD_OPTIONS.some((o) => o.value === k.fieldPath);
                  return (
                    <div key={k.key} className="rounded-lg border border-neutral-200 p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-600">
                          Requirement
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
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-neutral-600">
                          Rule
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
                            {(knockoutFieldDef(k.fieldPath)?.types ?? KNOCKOUT_TYPES).map((t) => (
                              <option key={t} value={t}>
                                {KNOCKOUT_TYPE_LABELS[t]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-neutral-600">
                          CV detail to check
                          <select
                            className={inputCls}
                            value={fieldIsKnown ? k.fieldPath : KNOCKOUT_FIELD_OTHER}
                            onChange={(e) =>
                              setKnockouts(
                                knockouts.map((x) =>
                                  x.key === k.key
                                    ? withKnockoutField(
                                        x,
                                        e.target.value === KNOCKOUT_FIELD_OTHER
                                          ? ""
                                          : e.target.value,
                                        basics.compBandMax,
                                      )
                                    : x,
                                ),
                              )
                            }
                          >
                            {KNOCKOUT_FIELD_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                            <option value={KNOCKOUT_FIELD_OTHER}>Other (advanced)…</option>
                          </select>
                        </label>
                        {!fieldIsKnown ? (
                          <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-600">
                            Advanced, parsed-CV field path
                            <input
                              className={inputCls}
                              value={k.fieldPath}
                              placeholder="e.g. skills.certifications"
                              onChange={(e) =>
                                setKnockouts(
                                  knockouts.map((x) =>
                                    x.key === k.key ? { ...x, fieldPath: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          </label>
                        ) : null}
                        {k.type !== "boolean" ? (
                          <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-600">
                            {k.type === "enum" ? "Allowed values" : "Threshold"}
                            {knockoutFieldDef(k.fieldPath)?.unitHint
                              ? ` (${knockoutFieldDef(k.fieldPath)?.unitHint})`
                              : ""}
                            <input
                              className={inputCls}
                              value={k.value}
                              inputMode={k.type === "enum" ? undefined : "numeric"}
                              placeholder={
                                k.type === "enum"
                                  ? "Allowed values, comma-separated"
                                  : knockoutFieldDef(k.fieldPath)?.valueKind === "money"
                                    ? "Annual amount, e.g. 1800000"
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
                          </label>
                        ) : null}
                      </div>
                      <button
                        className="mt-2 text-xs text-status-error-600 hover:underline"
                        onClick={() => setKnockouts(knockouts.filter((x) => x.key !== k.key))}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => onSaveAndNext(2)} disabled={busy}>
              Back
            </Button>
            <Button onClick={() => onSaveAndNext(4)} disabled={busy}>
              {updateDraft.isPending ? "Saving…" : "Save & continue"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* ─────────── Step 4: Interview rounds & panel ─────────── */}
      {step === 4 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">
            Interview rounds & panel
          </h2>
          <p className="mb-4 text-sm text-neutral-600">
            Define the interview loop for this role, rounds, mode, scorecard, competency focus, and
            a default panel. Panelists are confirmed at scheduling; this is the blueprint.
          </p>
          {rid ? (
            <InterviewPlanSection requisitionId={rid} canManage={true} />
          ) : (
            <p className="text-sm text-neutral-500">Create the draft first.</p>
          )}
          <div className="mt-6 flex justify-between">
            <Button
              variant="ghost"
              onClick={() => {
                planQuery.refetch();
                goToStep(3);
              }}
              disabled={busy}
            >
              Back
            </Button>
            <Button
              onClick={() => {
                planQuery.refetch();
                goToStep(5);
              }}
              disabled={busy}
            >
              Continue to review
            </Button>
          </div>
        </Card>
      ) : null}

      {/* ─────────── Step 5: Review & submit ─────────── */}
      {step === 5 ? (
        <Card padded={false} className="p-6">
          <h2 className="mb-1 text-base font-semibold text-neutral-900">Review & submit</h2>
          <p className="mb-4 text-sm text-neutral-600">
            Submitting sends this requisition to the HR head for approval. You can&rsquo;t edit it
            after submission.
          </p>

          <div className="mb-5 rounded-lg border border-neutral-200 p-4">
            <p className="mb-3 text-sm font-semibold text-neutral-900">Submission checklist</p>
            <ul className="space-y-2">
              {checklist.map((c) => (
                <li key={c.label} className="flex items-start gap-2 text-sm">
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                      c.ok ? "bg-status-success-600" : "bg-status-error-500"
                    }`}
                  >
                    {c.ok ? "✓" : "!"}
                  </span>
                  <span className="flex-1">
                    <span className={c.ok ? "text-neutral-700" : "text-neutral-900"}>
                      {c.label}
                    </span>
                    {!c.ok ? (
                      <button
                        className="ml-2 text-xs text-brand-600 hover:underline"
                        onClick={() => goToStep(c.step as Step)}
                      >
                        Fix in step {c.step}
                      </button>
                    ) : null}
                    {!c.ok && c.reason ? (
                      <span className="mt-0.5 block text-xs text-status-error-600">{c.reason}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <dl className="space-y-2 text-sm">
            <Row label="Title" value={basics.title || "—"} />
            {pickedProfile ? <Row label="Job profile" value={pickedProfile.title} /> : null}
            <Row label="Department" value={basics.department || "—"} />
            <Row
              label="Level"
              value={
                arch?.jobLevels.find((l) => l.id === basics.jobLevelId)?.label ||
                basics.seniority ||
                "—"
              }
            />
            {basics.jobFunctionId ? (
              <Row
                label="Function"
                value={arch?.jobFunctions.find((f) => f.id === basics.jobFunctionId)?.label ?? "—"}
              />
            ) : null}
            {basics.employmentTypeKey ? (
              <Row
                label="Employment type"
                value={
                  arch?.lookups.employmentType.find((x) => x.key === basics.employmentTypeKey)
                    ?.label ?? basics.employmentTypeKey
                }
              />
            ) : null}
            {basics.requisitionTypeKey ? (
              <Row
                label="Requisition type"
                value={
                  arch?.lookups.requisitionType.find((x) => x.key === basics.requisitionTypeKey)
                    ?.label ?? basics.requisitionTypeKey
                }
              />
            ) : null}
            <Row
              label="Location"
              value={`${basics.primaryLocation || "—"} (${basics.locationType})`}
            />
            <Row label="Comp band" value={pickedBand ? pickedBand.name : "Manual entry"} />
            <Row
              label="Budget band"
              value={
                budgetFilled
                  ? `₹${Number(basics.compBandMin).toLocaleString("en-IN")}–₹${Number(basics.compBandMax).toLocaleString("en-IN")} / yr`
                  : "—"
              }
            />
            <Row label="Openings" value={String(basics.numberOfOpenings)} />
            {diverseSlate.required ? (
              <Row
                label="Diverse slate"
                value={`Required, minimum ${diverseSlateInput().diverseSlateMin ?? `${diverseDefaults?.defaultMin ?? 2} (organisation default)`}`}
              />
            ) : null}
            <Row label="JD sections" value={`${filledSectionCount(sections)} of 7 filled`} />
            <Row
              label="Skills"
              value={
                skills.filter((s) => s.skillName.trim()).length > 0
                  ? skills
                      .filter((s) => s.skillName.trim())
                      .map((s) => `${s.skillName} (${s.weight}${s.isRequired ? "★" : ""})`)
                      .join(", ")
                  : "—"
              }
            />
            <Row label="Knockouts" value={String(knockouts.length)} />
            <Row label="Interview rounds" value={String(roundCount)} />
          </dl>

          <GateStatus scan={scan} />

          {/* Three buttons on one non-wrapping row ran off a phone and clipped
              "Submit for approval" — the one control the step exists for. */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" onClick={() => goToStep(4)} disabled={busy}>
              Back
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => persistDraft()} disabled={busy}>
                Save as draft
              </Button>
              <Button onClick={onSubmit} disabled={busy || !allGreen}>
                {submit.isPending ? "Submitting…" : "Submit for approval"}
              </Button>
            </div>
          </div>
          {!allGreen ? (
            <p className="mt-2 text-right text-xs text-neutral-500">
              Complete the checklist above to enable submission.
            </p>
          ) : null}
        </Card>
      ) : null}
    </PageContainer>
  );
}

interface ChecklistItem {
  label: string;
  ok: boolean;
  step: number;
  reason?: string;
}

function filledSectionCount(sections: JdSections): number {
  const lists: string[][] = [
    sections.responsibilities,
    sections.requirements,
    sections.niceToHave,
    sections.toolsTech,
    sections.education,
    sections.softSkills,
  ];
  let n = sections.summary.trim().length > 0 ? 1 : 0;
  for (const l of lists) if (l.some((x) => x.trim().length > 0)) n += 1;
  return n;
}

/**
 * PC-7 — switch a knockout row to another field. A catalogue field snaps the
 * rule to one it supports; picking expected CTC pre-fills the threshold with
 * the requisition's comp-band max (the "vs a req value" default) when empty.
 */
function withKnockoutField(row: KnockoutRow, fieldPath: string, compBandMax: string): KnockoutRow {
  const def = knockoutFieldDef(fieldPath);
  const type = def && !def.types.includes(row.type) ? (def.types[0] ?? row.type) : row.type;
  const value =
    def?.valueKind === "money" && row.value.trim() === "" && compBandMax.trim() !== ""
      ? compBandMax.trim()
      : row.value;
  return { ...row, fieldPath, type, value };
}

function toKnockoutInput(k: KnockoutRow): RequisitionKnockoutInput {
  const base = {
    questionText: k.questionText,
    type: k.type,
    // PC-7 — catalogue fields carry their own source (screening fields are
    // candidate_asserted); "Other (advanced)" paths stay parsed-CV.
    source: knockoutFieldDef(k.fieldPath)?.source ?? ("parsed_cv" as const),
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

/** Best-effort read of the persisted threshold_value jsonb back into the row. */
function knockoutFieldPath(threshold: unknown): string {
  if (threshold && typeof threshold === "object" && "field_path" in threshold) {
    return String((threshold as { field_path: unknown }).field_path ?? "total_years_experience");
  }
  return "total_years_experience";
}
function knockoutValueString(type: KnockoutRow["type"], threshold: unknown): string {
  if (!threshold || typeof threshold !== "object") return "";
  const t = threshold as Record<string, unknown>;
  if (type === "numeric_min" && t.min != null) return String(t.min);
  if (type === "numeric_max" && t.max != null) return String(t.max);
  if (type === "enum" && Array.isArray(t.allowed)) return (t.allowed as unknown[]).join(", ");
  return "";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

function Stepper({
  step,
  onJump,
  rid,
}: {
  step: Step;
  onJump: (n: Step) => void;
  rid: string | null;
}) {
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      {STEP_LABELS.map((l, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        const clickable = rid || n === 1;
        return (
          <li key={l} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onJump(n)}
              className="flex items-center gap-2 disabled:cursor-default"
            >
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
            </button>
            {i < STEP_LABELS.length - 1 ? <span className="text-neutral-300">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function AutosaveIndicator({
  savedAt,
  pending,
  hasRid,
}: {
  savedAt: number | null;
  pending: boolean;
  hasRid: boolean;
}) {
  if (!hasRid) return null;
  return (
    <p className="mb-4 text-[11px] text-neutral-400">
      {pending ? "Saving draft…" : savedAt ? "Draft saved to server" : "Draft persists as you go"}
    </p>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong. Please try again.";
}

/** Review-step gate status: clean / warnings / blocked (real lexicon scan). */
function GateStatus({ scan }: { scan: JdBiasScan | null }) {
  if (!scan || scan.enforcement === "off") return null;
  const blocked = scanBlocksSubmit(scan);
  if (blocked) {
    return (
      <div className="mt-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
        Bias gate: blocked, the JD contains coded language that must be revised before you can
        submit (see the Job description step).
      </div>
    );
  }
  if (scan.matches.length > 0) {
    // DISTINCT terms, not raw matches. The quality meter above counts distinct
    // term+category (computeJdBiasScore), and the HR head's queue shows distinct
    // flags (distinctBiasFlags server-side) — so counting raw matches here made
    // one JD report "2 block · 0 warn" on the meter and "4 flagged phrases"
    // directly beneath it, because two blocking terms each appeared twice.
    const distinct = new Set(scan.matches.map((m) => `${m.term.toLowerCase()}|${m.category}`)).size;
    return (
      <div className="mt-4 rounded-lg border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-700">
        Bias gate: {distinct} flagged {distinct === 1 ? "phrase" : "phrases"}, submission is
        allowed; the HR head will see the flags in the approval queue.
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
      Bias gate: clean, no coded language found.
    </div>
  );
}
