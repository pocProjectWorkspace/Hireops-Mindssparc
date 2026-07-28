"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button, Card, EmptyState } from "@/components/ui";
import { Input, Select } from "@hireops/ui";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { humanize, humanizeSentence } from "@/lib/labels";
import type { ApplicationStage, IrisActionMenuItem, IrisExecuteOutput } from "@hireops/api-types";
import { suggestedActionForRoute, type IrisPageContext } from "./context-map";
import { IrisApplicationPicker, type IrisPickedApplication } from "./IrisApplicationPicker";

/**
 * IrisDrawer (IRIS-A2) — the menu-path Iris surface. A right-side slide-over
 * (mirrors RecruiterBriefDrawer chrome) driving a menu → form → review →
 * done/error state machine, with confirm-before-commit:
 *
 *   menu    — grouped, whitelist-only action list (irisListActions), plus a
 *             context-suggested default at top.
 *   form    — the picked action's minimum-info input form.
 *   review  — the REAL server preview (irisPreview) + an explicit Confirm.
 *   done    — the executed result (irisExecute) + a link to what it created.
 *
 * HONESTY: no natural-language / LLM here (that's A3). The preview and the
 * commit are both the server's — the client never re-implements either. A
 * non-requisition-write role gets a calm "no actions" state, not a crash.
 */

type Step = "menu" | "form" | "review" | "done";

const LOCATION_TYPES = ["remote", "hybrid", "onsite", "multi"] as const;

/** The application-targeted Pipeline / Onboarding actions — they all share the
 * candidate/application picker rather than the requisition form. */
const APPLICATION_ACTION_IDS = new Set([
  "advance_application",
  "reject_application",
  "open_onboarding_case",
]);

/** Forward pipeline order — the stages an "advance" can move a candidate TO.
 * Terminal negatives (reject / withdraw / declined) are NOT advance targets;
 * reject_application owns ending an application. */
const PIPELINE_FORWARD: ApplicationStage[] = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

/** The forward stages available FROM the candidate's current stage. An
 * off-pipeline / terminal current stage (not in PIPELINE_FORWARD) falls back to
 * the full forward list rather than hiding every option. */
function forwardStagesAfter(current: ApplicationStage): ApplicationStage[] {
  const idx = PIPELINE_FORWARD.indexOf(current);
  return idx === -1 ? PIPELINE_FORWARD : PIPELINE_FORWARD.slice(idx + 1);
}

export interface IrisDrawerProps {
  open: boolean;
  onClose: () => void;
  context: IrisPageContext;
}

export function IrisDrawer({ open, onClose, context }: IrisDrawerProps) {
  const utils = trpc.useUtils();

  const [step, setStep] = useState<Step>("menu");
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [submittedParams, setSubmittedParams] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<IrisExecuteOutput | null>(null);

  // create_requisition_jd form fields (minimum-info; the schema defaults the
  // rest). title + locationType are the required minimum.
  const [title, setTitle] = useState("");
  const [businessUnitId, setBusinessUnitId] = useState("");
  const [locationType, setLocationType] = useState<string>("onsite");
  const [seniority, setSeniority] = useState("");
  const [openings, setOpenings] = useState("1");

  // Pipeline / Onboarding action fields (advance_application, reject_application,
  // open_onboarding_case) — all share the candidate/application picker.
  const [picked, setPicked] = useState<IrisPickedApplication | null>(null);
  const [targetStage, setTargetStage] = useState<string>("");
  const [rejectReason, setRejectReason] = useState("");

  // Reset to a clean menu each time the drawer opens; lock body scroll + wire ESC.
  useEffect(() => {
    if (!open) return;
    setStep("menu");
    setSelectedActionId(null);
    setSubmittedParams(null);
    setResult(null);
    setTitle("");
    setBusinessUnitId("");
    setLocationType("onsite");
    setSeniority("");
    setOpenings("1");
    setPicked(null);
    setTargetStage("");
    setRejectReason("");
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
  }, [open, onClose]);

  const actionsQuery = trpc.irisListActions.useQuery(undefined, { enabled: open });
  const forbidden = actionsQuery.error?.data?.code === "FORBIDDEN";
  const actions = actionsQuery.data?.actions ?? [];

  const businessUnitsQuery = trpc.listBusinessUnits.useQuery(
    {},
    { enabled: open && selectedActionId === "create_requisition_jd" },
  );
  const businessUnits = useMemo(
    () => (businessUnitsQuery.data?.rows ?? []).filter((u) => !u.isArchived),
    [businessUnitsQuery.data],
  );

  const previewQuery = trpc.irisPreview.useQuery(
    { actionId: selectedActionId ?? "", params: submittedParams },
    {
      enabled: step === "review" && !!selectedActionId && submittedParams != null,
      retry: false,
    },
  );

  const execute = trpc.irisExecute.useMutation({
    onSuccess: (data) => {
      setResult(data);
      setStep("done");
      void utils.listMyRequisitionsV2.invalidate();
      void utils.irisGetProvenance.invalidate();
      // Pipeline / Onboarding actions change what the candidate surfaces show.
      void utils.listCandidates.invalidate();
      void utils.listCandidatesByRequisition.invalidate();
      void utils.listShortlist.invalidate();
    },
    onError: (err) => handleTRPCError(err),
  });

  if (!open) return null;

  const suggestedId = suggestedActionForRoute(context.route);
  const suggested = suggestedId ? actions.find((a) => a.id === suggestedId) : undefined;

  const grouped = groupActions(actions);

  const selectedAction = actions.find((a) => a.id === selectedActionId);
  const selectedLabel = selectedAction?.label ?? "Action";
  const isDestructive = selectedAction?.destructive ?? false;
  const needsApplication = selectedActionId ? APPLICATION_ACTION_IDS.has(selectedActionId) : false;
  // Pre-select the picker from page context when the route names an application.
  const contextApplicationId = context.entityType === "application" ? context.entityId : undefined;

  function openForm(actionId: string) {
    setSelectedActionId(actionId);
    setSubmittedParams(null);
    setResult(null);
    setPicked(null);
    setTargetStage("");
    setRejectReason("");
    setStep("form");
  }

  function onSubmitForm() {
    let params: Record<string, unknown> | null = null;
    if (selectedActionId === "create_requisition_jd") {
      params = {
        title: title.trim(),
        locationType,
        numberOfOpenings: Math.max(1, Number.parseInt(openings, 10) || 1),
      };
      if (businessUnitId) params.businessUnitId = businessUnitId;
      if (seniority.trim()) params.seniority = seniority.trim();
    } else if (selectedActionId === "advance_application" && picked && targetStage) {
      params = { applicationId: picked.applicationId, targetStage };
    } else if (selectedActionId === "reject_application" && picked && rejectReason.trim()) {
      params = { applicationId: picked.applicationId, reason: rejectReason.trim() };
    } else if (selectedActionId === "open_onboarding_case" && picked) {
      params = { applicationId: picked.applicationId };
    }
    if (!params) return;
    setSubmittedParams(params);
    setStep("review");
  }

  // Per-action form validity — gates the Preview button.
  let canSubmitForm = false;
  if (selectedActionId === "create_requisition_jd") canSubmitForm = title.trim().length >= 2;
  else if (selectedActionId === "advance_application")
    canSubmitForm = !!picked && targetStage.length > 0;
  else if (selectedActionId === "reject_application")
    canSubmitForm = !!picked && rejectReason.trim().length > 0;
  else if (selectedActionId === "open_onboarding_case") canSubmitForm = !!picked;

  const stageOptions = picked ? forwardStagesAfter(picked.stage) : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Iris assistant"
      className="fixed inset-0 z-modal flex justify-end"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[34rem] max-w-[92vw] flex-col overflow-hidden bg-neutral-50 shadow-3">
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-6 py-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900">
              <span aria-hidden className="text-brand-500">
                ✨
              </span>
              Iris
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Runs real actions you confirm, every step is audited.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Close"
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

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {/* ── MENU ── */}
          {step === "menu" ? (
            actionsQuery.isLoading ? (
              <p className="text-sm text-neutral-500">Loading actions…</p>
            ) : forbidden ? (
              <EmptyState
                title="You don't have actions available here"
                hint="Iris actions are available to hiring managers and admins. Ask an administrator if you need access."
              />
            ) : actionsQuery.error ? (
              <p className="text-sm text-status-error-700">Couldn&apos;t load Iris actions.</p>
            ) : actions.length === 0 ? (
              <EmptyState
                title="No actions available"
                hint="No Iris actions are wired for your role yet."
              />
            ) : (
              <>
                {suggested ? (
                  <section>
                    <SectionHeading>Suggested here</SectionHeading>
                    <button
                      type="button"
                      onClick={() => openForm(suggested.id)}
                      className="flex w-full items-start gap-3 rounded-lg border border-brand-200 bg-brand-50 p-4 text-left transition-colors hover:border-brand-300 hover:bg-brand-100"
                    >
                      <span aria-hidden className="mt-0.5 text-brand-500">
                        ✨
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-brand-800">
                          {suggested.label}
                        </span>
                        <span className="block text-xs text-brand-700/80">
                          {humanize(suggested.group)}
                        </span>
                      </span>
                    </button>
                  </section>
                ) : null}

                {grouped.map(([group, items]) => (
                  <section key={group}>
                    <SectionHeading>{humanize(group)}</SectionHeading>
                    <div className="space-y-2">
                      {items.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          onClick={() => openForm(action.id)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-3.5 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                        >
                          <span className="text-sm font-medium text-neutral-800">
                            {action.label}
                          </span>
                          <span aria-hidden className="text-neutral-400">
                            →
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </>
            )
          ) : null}

          {/* ── FORM ── */}
          {step === "form" ? (
            <Card>
              <h3 className="mb-1 text-sm font-semibold text-neutral-900">{selectedLabel}</h3>
              <p className="mb-4 text-xs text-neutral-500">
                Provide the essentials, Iris fills sensible defaults for the rest. You&apos;ll
                confirm a preview before anything is created.
              </p>
              {selectedActionId === "create_requisition_jd" ? (
                <div className="space-y-4">
                  <Input
                    label="Role title"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Senior Backend Engineer"
                  />
                  <Select
                    label="Business unit"
                    placeholder={
                      businessUnitsQuery.isLoading ? "Loading units…" : "Select a business unit"
                    }
                    value={businessUnitId}
                    onValueChange={setBusinessUnitId}
                    disabled={businessUnitsQuery.isLoading}
                    options={businessUnits.map((u) => ({ value: u.id, label: u.name }))}
                    hint="Optional, leave unset to file it under the default unit."
                  />
                  <Select
                    label="Location type"
                    required
                    value={locationType}
                    onValueChange={setLocationType}
                    options={LOCATION_TYPES.map((t) => ({ value: t, label: humanize(t) }))}
                  />
                  <Input
                    label="Seniority"
                    value={seniority}
                    onChange={(e) => setSeniority(e.target.value)}
                    placeholder="Senior"
                  />
                  <Input
                    label="Number of openings"
                    type="number"
                    min={1}
                    value={openings}
                    onChange={(e) => setOpenings(e.target.value)}
                  />
                </div>
              ) : needsApplication ? (
                <div className="space-y-4">
                  <IrisApplicationPicker
                    value={picked}
                    onChange={(p) => {
                      setPicked(p);
                      setTargetStage("");
                    }}
                    enabled={step === "form"}
                    preselectApplicationId={contextApplicationId}
                  />

                  {selectedActionId === "advance_application" && picked ? (
                    stageOptions.length > 0 ? (
                      <Select
                        label="Advance to stage"
                        required
                        placeholder="Select a stage"
                        value={targetStage}
                        onValueChange={setTargetStage}
                        options={stageOptions.map((s) => ({
                          value: s,
                          label: humanizeSentence(s),
                        }))}
                      />
                    ) : (
                      <p className="text-sm text-neutral-500">
                        This candidate is already at the final pipeline stage, there is no forward
                        stage to advance to.
                      </p>
                    )
                  ) : null}

                  {selectedActionId === "reject_application" && picked ? (
                    <label className="block text-sm font-medium text-neutral-800">
                      Reason
                      <span aria-hidden className="text-status-error-600">
                        {" "}
                        *
                      </span>
                      <textarea
                        value={rejectReason}
                        rows={3}
                        onChange={(e) => setRejectReason(e.target.value)}
                        maxLength={500}
                        placeholder="Why is this candidate being rejected? This is recorded on the audit trail."
                        className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                      />
                    </label>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-neutral-500">This action has no input form wired yet.</p>
              )}
              <div className="mt-5 flex items-center justify-between gap-2">
                <Button variant="secondary" onClick={() => setStep("menu")}>
                  Back
                </Button>
                <Button onClick={onSubmitForm} disabled={!canSubmitForm}>
                  Preview
                </Button>
              </div>
            </Card>
          ) : null}

          {/* ── REVIEW ── */}
          {step === "review" ? (
            <Card>
              <h3 className="mb-3 text-sm font-semibold text-neutral-900">Review &amp; confirm</h3>
              {isDestructive ? (
                <div className="mb-3 rounded-lg border border-status-error-200 bg-status-error-50 px-3 py-2.5">
                  <p className="text-sm font-medium text-status-error-800">
                    This ends the candidate&apos;s application.
                  </p>
                  <p className="mt-0.5 text-xs text-status-error-700">
                    It&apos;s recorded on the audit trail and can be undone from triage within a
                    short window.
                  </p>
                </div>
              ) : null}
              {previewQuery.isLoading ? (
                <p className="text-sm text-neutral-500">Building preview…</p>
              ) : previewQuery.error ? (
                <p className="text-sm text-status-error-700">
                  {previewQuery.error.message || "Couldn't build the preview."}
                </p>
              ) : previewQuery.data ? (
                <div className="rounded-lg border border-neutral-200 bg-white p-4">
                  <p className="text-sm font-medium text-neutral-900">
                    {previewQuery.data.summary}
                  </p>
                  {previewQuery.data.details.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-sm text-neutral-600">
                      {previewQuery.data.details.map((d, i) => (
                        <li key={i} className="flex gap-2">
                          <span aria-hidden className="text-neutral-300">
                            •
                          </span>
                          {d}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {execute.error ? (
                <p className="mt-3 text-sm text-status-error-700">
                  {execute.error.message || "Couldn't complete the action."}
                </p>
              ) : null}

              <p className="mt-3 text-[11px] text-neutral-400">
                Confirming runs the same gated action a person would, it&apos;s recorded in the
                audit trail and tagged as Iris-assisted.
              </p>
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setStep("form")}
                  disabled={execute.isPending}
                >
                  Back
                </Button>
                <Button
                  variant={isDestructive ? "danger" : "primary"}
                  onClick={() =>
                    selectedActionId && submittedParams
                      ? execute.mutate({ actionId: selectedActionId, params: submittedParams })
                      : undefined
                  }
                  disabled={
                    execute.isPending || previewQuery.isLoading || Boolean(previewQuery.error)
                  }
                >
                  {execute.isPending ? "Working…" : isDestructive ? "Confirm reject" : "Confirm"}
                </Button>
              </div>
            </Card>
          ) : null}

          {/* ── DONE ── */}
          {step === "done" && result ? (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-status-positive-50 text-status-positive-700"
                >
                  ✓
                </span>
                <h3 className="text-sm font-semibold text-neutral-900">Done</h3>
              </div>
              <p className="text-sm text-neutral-700">{result.resultSummary}</p>
              <div className="mt-4 flex items-center gap-3">
                {result.entityType === "requisition" && result.entityId ? (
                  <a
                    href={`/requisitions/${result.entityId}`}
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    Open requisition →
                  </a>
                ) : null}
                {result.entityType === "application" && result.entityId && picked ? (
                  <a
                    href={`/candidates?candidateId=${picked.candidateId}&applicationId=${result.entityId}`}
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    Open candidate →
                  </a>
                ) : null}
                <Button variant="secondary" onClick={() => setStep("menu")}>
                  Back to actions
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </h3>
  );
}

/** Group menu items by their `group`, preserving first-seen group order. */
function groupActions(actions: IrisActionMenuItem[]): [string, IrisActionMenuItem[]][] {
  const map = new Map<string, IrisActionMenuItem[]>();
  for (const action of actions) {
    const list = map.get(action.group) ?? [];
    list.push(action);
    map.set(action.group, list);
  }
  return Array.from(map.entries());
}
