"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Button, Card, EmptyState } from "@/components/ui";
import { Input, Select } from "@hireops/ui";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { humanize, humanizeSentence } from "@/lib/labels";
import { applicationStageSchema } from "@hireops/api-types";
import type {
  ApplicationStage,
  IrisActionMenuItem,
  IrisExecuteOutput,
  IrisResolveIntentOutput,
} from "@hireops/api-types";
import { suggestedActionForRoute, type IrisPageContext } from "./context-map";
import { IrisApplicationPicker, type IrisPickedApplication } from "./IrisApplicationPicker";
import { IrisDocumentTypeMultiSelect } from "./IrisDocumentTypeMultiSelect";
import { IrisOfferPicker, type IrisPickedOffer } from "./IrisOfferPicker";
import { IrisInterviewPicker, type IrisPickedInterview } from "./IrisInterviewPicker";

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
 * IRIS-A3 adds a natural-language chat input as a THIRD entry mode (alongside
 * the suggested-default + grouped menu). Free text → irisResolveIntent, which
 * PROPOSES a whitelisted action + draft params; the drawer opens that action's
 * existing form, prefilled, and seeds the pickers from the resolver's free-text
 * hints. Nothing auto-executes — the proposal flows into the SAME preview →
 * confirm → execute path, and the resolver never resolves a concrete entity id.
 *
 * HONESTY: the NL layer only PROPOSES. The preview and the commit are still the
 * server's — the client never re-implements either. A non-requisition-write role
 * gets a calm "no actions" state, not a crash.
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

/** The IRIS-B2 FILTER-based bulk actions — they share a requisition + stage
 * filter form (not the single-application picker) and a confirm-N review. */
const BULK_ACTION_IDS = new Set(["bulk_advance_applications", "bulk_reject_applications"]);

/** The requisition HOLD / RESUME lifecycle actions — they share a single
 * requisition picker (hold also collects a required reason). */
const REQUISITION_HOLD_ACTION_IDS = new Set(["hold_requisition", "resume_requisition"]);

/** request_documents — the application picker + a document-type multi-select. */
const DOCUMENTS_ACTION_ID = "request_documents";
/** request_offer_approval — a single offer picker (comp desk read). */
const OFFER_APPROVAL_ACTION_ID = "request_offer_approval";
/** cancel_interview — an interview picker + a required reason (destructive). */
const CANCEL_INTERVIEW_ACTION_ID = "cancel_interview";

/** Every pipeline stage — the from/target selects offer the full set (a bulk
 * filter can act on any current stage). */
const ALL_STAGES = applicationStageSchema.options as readonly ApplicationStage[];

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

  // Portal-mount guard: the drawer mounts from the "Ask Iris" launcher inside
  // the PageHeader, so a plain `fixed` element gets trapped in that subtree's
  // stacking context and page content bleeds over it. We portal into
  // document.body (client-only) so it renders above everything.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [step, setStep] = useState<Step>("menu");
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [submittedParams, setSubmittedParams] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<IrisExecuteOutput | null>(null);

  // IRIS-A3 natural-language entry mode. `nlText` is the chat input; `nlResult`
  // holds the resolver's response so a no-action clarifyingQuestion / message can
  // be shown in the chat area. The seeds carry the resolver's free-text picker
  // hints (never ids) into the opened form's pickers.
  const [nlText, setNlText] = useState("");
  const [nlResult, setNlResult] = useState<IrisResolveIntentOutput | null>(null);
  const [nlCandidateSeed, setNlCandidateSeed] = useState("");
  const [nlRequisitionSeed, setNlRequisitionSeed] = useState("");

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

  // IRIS-B2 bulk pipeline action fields — a requisition + current-stage FILTER
  // (plus a target stage for advance / a reason for reject).
  const [bulkRequisitionId, setBulkRequisitionId] = useState("");
  const [bulkFromStage, setBulkFromStage] = useState<string>("");
  const [bulkTargetStage, setBulkTargetStage] = useState<string>("");
  const [bulkReason, setBulkReason] = useState("");

  // message_candidate fields — shares the application picker. `messageIntent` is
  // the recruiter's free-text steer for the "Draft with Iris" call; the returned
  // draft prefills the EDITABLE `messageSubject` + `messageBody`, which the human
  // may change freely before Confirm. Nothing sends until the review's Confirm.
  const [messageIntent, setMessageIntent] = useState("");
  const [messageSubject, setMessageSubject] = useState("");
  const [messageBody, setMessageBody] = useState("");

  // Requisition hold / resume fields — a single requisition picker; hold also
  // collects a required, human-entered reason.
  const [holdRequisitionId, setHoldRequisitionId] = useState("");
  const [holdReason, setHoldReason] = useState("");

  // Tier-A contextual action fields.
  // request_documents — shares the application picker; `docTypeIds` are the
  // checked document types (at least one required).
  const [docTypeIds, setDocTypeIds] = useState<string[]>([]);
  // request_offer_approval — a single offer picker (the comp desk read).
  const [pickedOffer, setPickedOffer] = useState<IrisPickedOffer | null>(null);
  // cancel_interview — an interview picker + a required, human-entered reason.
  const [pickedInterview, setPickedInterview] = useState<IrisPickedInterview | null>(null);
  const [cancelReason, setCancelReason] = useState("");

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
    setBulkRequisitionId("");
    setBulkFromStage("");
    setBulkTargetStage("");
    setBulkReason("");
    setMessageIntent("");
    setMessageSubject("");
    setMessageBody("");
    setHoldRequisitionId("");
    setHoldReason("");
    setDocTypeIds([]);
    setPickedOffer(null);
    setPickedInterview(null);
    setCancelReason("");
    setNlText("");
    setNlResult(null);
    setNlCandidateSeed("");
    setNlRequisitionSeed("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // T-FIX-1 (Fix B) — no body scroll-lock: this is a NON-blocking side panel,
    // the page behind stays scrollable/interactive. ESC + the X still close it.
    return () => {
      window.removeEventListener("keydown", onKey);
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

  // The requisition picker read, shared by the IRIS-B2 bulk actions AND the
  // hold / resume lifecycle actions. listMyRequisitionsV2 is the same read gate
  // (hiring_manager / recruiter / admin) and carries the requisition id + title +
  // current status these forms need.
  const requisitionsQuery = trpc.listMyRequisitionsV2.useQuery(
    { limit: 200 },
    {
      enabled:
        open &&
        !!selectedActionId &&
        (BULK_ACTION_IDS.has(selectedActionId) ||
          REQUISITION_HOLD_ACTION_IDS.has(selectedActionId)),
    },
  );
  const requisitions = useMemo(() => requisitionsQuery.data?.rows ?? [], [requisitionsQuery.data]);

  const previewQuery = trpc.irisPreview.useQuery(
    { actionId: selectedActionId ?? "", params: submittedParams },
    {
      enabled: step === "review" && !!selectedActionId && submittedParams != null,
      retry: false,
    },
  );

  // IRIS-A3 — the bulk requisition selector is a dropdown (not a search box), so
  // best-effort AUTO-SELECT the requisition whose title matches the resolver's
  // free-text `requisitionQuery` seed once the list loads. The human can still
  // change it; if nothing matches, the selector just stays on its placeholder.
  useEffect(() => {
    if (!nlRequisitionSeed) return;
    if (!selectedActionId || !BULK_ACTION_IDS.has(selectedActionId)) return;
    if (bulkRequisitionId) return;
    if (requisitions.length === 0) return;
    const seed = nlRequisitionSeed.toLowerCase();
    const match = requisitions.find((r) => (r.title ?? "").toLowerCase().includes(seed));
    if (match) setBulkRequisitionId(match.id);
  }, [nlRequisitionSeed, selectedActionId, bulkRequisitionId, requisitions]);

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
      // Tier-A contextual actions change the comp desk / interviews surfaces.
      void utils.listCompDesk.invalidate();
      void utils.listUpcomingInterviews.invalidate();
    },
    onError: (err) => handleTRPCError(err),
  });

  // IRIS-A3 — resolve free text to a PROPOSED action + draft params. On a
  // resolved, eligible action we open its existing form prefilled and seed the
  // pickers; otherwise we keep the user on the menu with the chat note. The
  // server degrades gracefully (returns a message, never a 500), so the failure
  // case is really just a transport error.
  const resolveIntent = trpc.irisResolveIntent.useMutation({
    onSuccess: (data) => {
      setNlResult(data);
      if (data.actionId && actions.some((a) => a.id === data.actionId)) {
        openForm(data.actionId);
        applyResolvedParams(data.actionId, data.params);
        setNlCandidateSeed(data.hints.candidateQuery ?? "");
        setNlRequisitionSeed(data.hints.requisitionQuery ?? "");
      }
    },
  });

  // message_candidate — AI DRAFTS the email (proposes only); the returned subject
  // + body prefill the EDITABLE fields. Nothing sends here — the human edits, then
  // Confirms on the review step, which runs the real gated messageCandidate send.
  const draftMessage = trpc.irisDraftCandidateMessage.useMutation({
    onSuccess: (data) => {
      setMessageSubject(data.subject);
      setMessageBody(data.body);
    },
  });

  if (!open || !mounted) return null;

  const suggestedId = suggestedActionForRoute(context.route);
  const suggested = suggestedId ? actions.find((a) => a.id === suggestedId) : undefined;

  const grouped = groupActions(actions);

  const selectedAction = actions.find((a) => a.id === selectedActionId);
  const selectedLabel = selectedAction?.label ?? "Action";
  const isDestructive = selectedAction?.destructive ?? false;
  const needsApplication = selectedActionId ? APPLICATION_ACTION_IDS.has(selectedActionId) : false;
  const isBulk = selectedActionId ? BULK_ACTION_IDS.has(selectedActionId) : false;
  const isMessage = selectedActionId === "message_candidate";
  const isRequisitionHold = selectedActionId
    ? REQUISITION_HOLD_ACTION_IDS.has(selectedActionId)
    : false;
  const isDocuments = selectedActionId === DOCUMENTS_ACTION_ID;
  const isOfferApproval = selectedActionId === OFFER_APPROVAL_ACTION_ID;
  const isCancelInterview = selectedActionId === CANCEL_INTERVIEW_ACTION_ID;
  // Pre-select the picker from page context when the route names an application.
  const contextApplicationId = context.entityType === "application" ? context.entityId : undefined;

  function openForm(actionId: string) {
    setSelectedActionId(actionId);
    setSubmittedParams(null);
    setResult(null);
    setPicked(null);
    setTargetStage("");
    setRejectReason("");
    setBulkRequisitionId("");
    setBulkFromStage("");
    setBulkTargetStage("");
    setBulkReason("");
    setMessageIntent("");
    setMessageSubject("");
    setMessageBody("");
    setHoldRequisitionId("");
    setHoldReason("");
    setDocTypeIds([]);
    setPickedOffer(null);
    setPickedInterview(null);
    setCancelReason("");
    // Opening a form clears any prior NL picker seeds. A natural-language open
    // re-sets them AFTER this call, so the resolved seeds still apply.
    setNlCandidateSeed("");
    setNlRequisitionSeed("");
    setStep("form");
  }

  /**
   * IRIS-A3 — prefill the opened action's form fields from the resolver's DRAFT
   * params. Only the scalar fields each form actually reads are set (the params
   * carry no entity id — targets are seeded into the pickers instead). Values
   * are re-validated against the form's own option sets so a stray value can't
   * put the form into an impossible state. advance_application's targetStage
   * depends on the picked candidate's forward stages, so it's chosen after the
   * human picks — nothing to prefill here.
   */
  function applyResolvedParams(actionId: string, params: Record<string, unknown>) {
    const asString = (v: unknown) => (typeof v === "string" ? v : "");
    const isStage = (v: unknown): v is ApplicationStage =>
      typeof v === "string" && (ALL_STAGES as readonly string[]).includes(v);
    if (actionId === "create_requisition_jd") {
      setTitle(asString(params.title));
      setBusinessUnitId("");
      const loc = params.locationType;
      setLocationType(
        typeof loc === "string" && (LOCATION_TYPES as readonly string[]).includes(loc)
          ? loc
          : "onsite",
      );
      setSeniority(asString(params.seniority));
      setOpenings(
        typeof params.numberOfOpenings === "number" ? String(params.numberOfOpenings) : "1",
      );
    } else if (actionId === "reject_application") {
      setRejectReason(asString(params.reason));
    } else if (actionId === "bulk_advance_applications") {
      if (isStage(params.fromStage)) setBulkFromStage(params.fromStage);
      if (isStage(params.targetStage)) setBulkTargetStage(params.targetStage);
    } else if (actionId === "bulk_reject_applications") {
      if (isStage(params.fromStage)) setBulkFromStage(params.fromStage);
      setBulkReason(asString(params.reason));
    }
  }

  function onSubmitNl() {
    const text = nlText.trim();
    if (!text) return;
    setNlResult(null);
    resolveIntent.mutate({
      text,
      context: {
        route: context.route,
        ...(context.entityType ? { entityType: context.entityType } : {}),
        ...(context.entityId ? { entityId: context.entityId } : {}),
      },
    });
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
    } else if (
      selectedActionId === "bulk_advance_applications" &&
      bulkRequisitionId &&
      bulkFromStage &&
      bulkTargetStage
    ) {
      params = {
        requisitionId: bulkRequisitionId,
        fromStage: bulkFromStage,
        targetStage: bulkTargetStage,
      };
    } else if (
      selectedActionId === "bulk_reject_applications" &&
      bulkRequisitionId &&
      bulkFromStage
    ) {
      params = { requisitionId: bulkRequisitionId, fromStage: bulkFromStage };
      if (bulkReason.trim()) params.reason = bulkReason.trim();
    } else if (
      selectedActionId === "message_candidate" &&
      picked &&
      messageSubject.trim() &&
      messageBody.trim()
    ) {
      params = {
        applicationId: picked.applicationId,
        subject: messageSubject.trim(),
        body: messageBody.trim(),
      };
    } else if (selectedActionId === "hold_requisition" && holdRequisitionId && holdReason.trim()) {
      params = { requisitionId: holdRequisitionId, reason: holdReason.trim() };
    } else if (selectedActionId === "resume_requisition" && holdRequisitionId) {
      params = { requisitionId: holdRequisitionId };
    } else if (selectedActionId === DOCUMENTS_ACTION_ID && picked && docTypeIds.length > 0) {
      params = { applicationId: picked.applicationId, documentTypeIds: docTypeIds };
    } else if (selectedActionId === OFFER_APPROVAL_ACTION_ID && pickedOffer) {
      params = { offerId: pickedOffer.offerId };
    } else if (
      selectedActionId === CANCEL_INTERVIEW_ACTION_ID &&
      pickedInterview &&
      cancelReason.trim()
    ) {
      params = { interviewId: pickedInterview.interviewId, reason: cancelReason.trim() };
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
  else if (selectedActionId === "bulk_advance_applications")
    canSubmitForm = !!bulkRequisitionId && !!bulkFromStage && !!bulkTargetStage;
  else if (selectedActionId === "bulk_reject_applications")
    canSubmitForm = !!bulkRequisitionId && !!bulkFromStage;
  else if (selectedActionId === "message_candidate")
    canSubmitForm = !!picked && messageSubject.trim().length > 0 && messageBody.trim().length > 0;
  else if (selectedActionId === "hold_requisition")
    canSubmitForm = !!holdRequisitionId && holdReason.trim().length > 0;
  else if (selectedActionId === "resume_requisition") canSubmitForm = !!holdRequisitionId;
  else if (selectedActionId === DOCUMENTS_ACTION_ID)
    canSubmitForm = !!picked && docTypeIds.length > 0;
  else if (selectedActionId === OFFER_APPROVAL_ACTION_ID) canSubmitForm = !!pickedOffer;
  else if (selectedActionId === CANCEL_INTERVIEW_ACTION_ID)
    canSubmitForm = !!pickedInterview && cancelReason.trim().length > 0;

  const stageOptions = picked ? forwardStagesAfter(picked.stage) : [];

  // IRIS-B2 confirm-N gate — the resolved affected set the server returns for a
  // bulk preview; the client confirms an explicit N (and offers no confirm when
  // nothing matches the filter).
  const affected = previewQuery.data?.affected;
  const affectedCount = affected?.length ?? 0;
  const bulkEmpty = isBulk && previewQuery.data != null && affectedCount === 0;

  return createPortal(
    <div
      role="dialog"
      aria-label="Iris assistant"
      // T-FIX-1 (Fix B) — a genuinely non-blocking side panel. The root spans
      // the viewport (so the panel can pin right + float above content via
      // z-modal) but is pointer-events-none, so ONLY the <aside> captures input
      // and the page behind stays fully usable. No backdrop button (that's what
      // blocked the page + killed click-away); closing is ESC + the X button.
      className="pointer-events-none fixed inset-0 z-modal flex justify-end"
    >
      <aside className="pointer-events-auto relative ml-auto flex h-full w-[34rem] max-w-[92vw] flex-col overflow-hidden bg-neutral-50 shadow-3">
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
                {/* ── NL chat input (IRIS-A3) — a third entry mode. ── */}
                <section>
                  <SectionHeading>Ask Iris</SectionHeading>
                  <div className="space-y-2">
                    <textarea
                      value={nlText}
                      rows={2}
                      onChange={(e) => setNlText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmitNl();
                      }}
                      maxLength={1000}
                      placeholder="Describe what you want to do, e.g. “Reject Priya Nair — not enough backend experience”."
                      className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] text-neutral-400">
                        Iris drafts an action for you to review and confirm, it never sends anything
                        on its own.
                      </p>
                      <Button
                        onClick={onSubmitNl}
                        disabled={resolveIntent.isPending || nlText.trim().length === 0}
                      >
                        {resolveIntent.isPending ? "Thinking…" : "Ask"}
                      </Button>
                    </div>
                    {resolveIntent.isError ? (
                      <p className="text-sm text-status-error-700">
                        Couldn&apos;t reach Iris just now, pick an action from the menu below.
                      </p>
                    ) : null}
                    {nlResult && !nlResult.actionId ? (
                      <div className="rounded-lg border border-neutral-200 bg-white p-3 text-sm text-neutral-700">
                        {nlResult.clarifyingQuestion ??
                          nlResult.message ??
                          "I couldn't map that to an action, try rephrasing or pick one from the menu."}
                        {/* T-FIX-1 (Fix C) — an out-of-catalog "can't do that"
                            case (no clarifying question) tells the user what Iris
                            CAN do, drawn from their OWN already-gated actions.
                            Exposes no new capability; a clarifying question keeps
                            the current behaviour (show the question only). */}
                        {!nlResult.clarifyingQuestion && actions.length > 0 ? (
                          <div className="mt-3 border-t border-neutral-100 pt-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                              Here&apos;s what Iris can do
                            </p>
                            <div className="space-y-2">
                              {grouped.map(([group, items]) => (
                                <div key={group}>
                                  <p className="text-[11px] font-medium text-neutral-400">
                                    {humanize(group)}
                                  </p>
                                  <ul className="mt-0.5 space-y-0.5">
                                    {items.map((action) => (
                                      <li key={action.id} className="flex gap-2 text-neutral-600">
                                        <span aria-hidden className="text-neutral-300">
                                          •
                                        </span>
                                        {action.label}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </section>

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
                    initialSearch={nlCandidateSeed || undefined}
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
              ) : isMessage ? (
                <div className="space-y-4">
                  <IrisApplicationPicker
                    value={picked}
                    onChange={(p) => {
                      setPicked(p);
                      // A different candidate invalidates a draft written for the
                      // previous one — clear it so nothing stale carries over.
                      setMessageSubject("");
                      setMessageBody("");
                    }}
                    enabled={step === "form"}
                    preselectApplicationId={contextApplicationId}
                    initialSearch={nlCandidateSeed || undefined}
                  />

                  <label className="block text-sm font-medium text-neutral-800">
                    What should the message say?
                    <textarea
                      value={messageIntent}
                      rows={2}
                      onChange={(e) => setMessageIntent(e.target.value)}
                      maxLength={500}
                      placeholder="e.g. Let them know we're moving them to the final interview round and will follow up with times."
                      className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-neutral-400">
                      Iris drafts a message from this candidate&apos;s real application context, you
                      edit it, then confirm before anything is sent.
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        picked && messageIntent.trim()
                          ? draftMessage.mutate({
                              applicationId: picked.applicationId,
                              intent: messageIntent.trim(),
                            })
                          : undefined
                      }
                      disabled={
                        !picked || messageIntent.trim().length === 0 || draftMessage.isPending
                      }
                    >
                      {draftMessage.isPending ? "Drafting…" : "Draft with Iris"}
                    </Button>
                  </div>
                  {draftMessage.isError ? (
                    <p className="text-sm text-status-error-700">
                      Couldn&apos;t draft a message just now, you can write one below and send it.
                    </p>
                  ) : null}

                  <Input
                    label="Subject"
                    required
                    value={messageSubject}
                    onChange={(e) => setMessageSubject(e.target.value)}
                    maxLength={200}
                    placeholder="Subject line"
                  />
                  <label className="block text-sm font-medium text-neutral-800">
                    Message
                    <span aria-hidden className="text-status-error-600">
                      {" "}
                      *
                    </span>
                    <textarea
                      value={messageBody}
                      rows={8}
                      onChange={(e) => setMessageBody(e.target.value)}
                      maxLength={4000}
                      placeholder="Write your message, or draft one with Iris above."
                      className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    />
                  </label>
                  {draftMessage.isSuccess &&
                  messageSubject.trim().length > 0 &&
                  messageBody.trim().length > 0 ? (
                    <p className="text-[11px] text-brand-700/80">
                      ✨ Drafted by Iris, edit it before sending.
                    </p>
                  ) : null}
                </div>
              ) : isRequisitionHold ? (
                <div className="space-y-4">
                  <Select
                    label="Requisition"
                    required
                    placeholder={
                      requisitionsQuery.isLoading
                        ? "Loading requisitions…"
                        : selectedActionId === "resume_requisition"
                          ? "Select a requisition on hold"
                          : "Select a requisition"
                    }
                    value={holdRequisitionId}
                    onValueChange={setHoldRequisitionId}
                    disabled={requisitionsQuery.isLoading}
                    options={requisitions
                      .filter((r) =>
                        selectedActionId === "resume_requisition" ? r.status === "on_hold" : true,
                      )
                      .map((r) => ({
                        value: r.id,
                        label: `${r.title ?? "Untitled requisition"} — ${humanizeSentence(r.status)}`,
                      }))}
                    hint={
                      selectedActionId === "resume_requisition"
                        ? "Only requisitions currently on hold can be resumed."
                        : "Only an approved or posted requisition can be put on hold."
                    }
                  />
                  {selectedActionId === "hold_requisition" ? (
                    <label className="block text-sm font-medium text-neutral-800">
                      Reason for hold
                      <span aria-hidden className="text-status-error-600">
                        {" "}
                        *
                      </span>
                      <textarea
                        value={holdReason}
                        rows={3}
                        onChange={(e) => setHoldReason(e.target.value)}
                        maxLength={500}
                        placeholder="Why is this requisition being put on hold? Recorded on the audit trail."
                        className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                      />
                    </label>
                  ) : (
                    <p className="text-sm text-neutral-500">
                      Resuming clears the hold and returns the requisition to its active status.
                    </p>
                  )}
                </div>
              ) : isBulk ? (
                <div className="space-y-4">
                  <Select
                    label="Requisition"
                    required
                    placeholder={
                      requisitionsQuery.isLoading ? "Loading requisitions…" : "Select a requisition"
                    }
                    value={bulkRequisitionId}
                    onValueChange={setBulkRequisitionId}
                    disabled={requisitionsQuery.isLoading}
                    options={requisitions.map((r) => ({
                      value: r.id,
                      label: r.title ?? "Untitled requisition",
                    }))}
                  />
                  <Select
                    label="Current stage"
                    required
                    placeholder="Select the stage to act on"
                    value={bulkFromStage}
                    onValueChange={(v) => {
                      setBulkFromStage(v);
                      setBulkTargetStage("");
                    }}
                    options={ALL_STAGES.map((s) => ({ value: s, label: humanizeSentence(s) }))}
                    hint="Iris acts on every candidate on this requisition currently at this stage."
                  />
                  {selectedActionId === "bulk_advance_applications" ? (
                    <Select
                      label="Advance to stage"
                      required
                      placeholder="Select the target stage"
                      value={bulkTargetStage}
                      onValueChange={setBulkTargetStage}
                      options={ALL_STAGES.filter((s) => s !== bulkFromStage).map((s) => ({
                        value: s,
                        label: humanizeSentence(s),
                      }))}
                    />
                  ) : (
                    <label className="block text-sm font-medium text-neutral-800">
                      Reason
                      <textarea
                        value={bulkReason}
                        rows={3}
                        onChange={(e) => setBulkReason(e.target.value)}
                        maxLength={500}
                        placeholder="Why are these candidates being rejected? Recorded on each candidate's audit trail. Optional."
                        className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                      />
                    </label>
                  )}
                </div>
              ) : isDocuments ? (
                <div className="space-y-4">
                  <IrisApplicationPicker
                    value={picked}
                    onChange={(p) => {
                      setPicked(p);
                      // A different candidate clears any doc types picked for the
                      // previous one.
                      setDocTypeIds([]);
                    }}
                    enabled={step === "form"}
                    preselectApplicationId={contextApplicationId}
                    initialSearch={nlCandidateSeed || undefined}
                  />
                  {picked ? (
                    <IrisDocumentTypeMultiSelect
                      value={docTypeIds}
                      onChange={setDocTypeIds}
                      enabled={step === "form"}
                    />
                  ) : null}
                </div>
              ) : isOfferApproval ? (
                <div className="space-y-4">
                  <IrisOfferPicker
                    value={pickedOffer}
                    onChange={setPickedOffer}
                    enabled={step === "form"}
                  />
                </div>
              ) : isCancelInterview ? (
                <div className="space-y-4">
                  <IrisInterviewPicker
                    value={pickedInterview}
                    onChange={(p) => {
                      setPickedInterview(p);
                      // A different interview invalidates a reason typed for the
                      // previous one.
                      setCancelReason("");
                    }}
                    enabled={step === "form"}
                  />
                  {pickedInterview ? (
                    <label className="block text-sm font-medium text-neutral-800">
                      Reason
                      <span aria-hidden className="text-status-error-600">
                        {" "}
                        *
                      </span>
                      <textarea
                        value={cancelReason}
                        rows={3}
                        onChange={(e) => setCancelReason(e.target.value)}
                        maxLength={500}
                        placeholder="Why is this interview being cancelled? The candidate is notified and it's recorded on the audit trail."
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
                    {isCancelInterview
                      ? "This cancels the interview and notifies the candidate."
                      : "This ends the candidate's application."}
                  </p>
                  <p className="mt-0.5 text-xs text-status-error-700">
                    {isCancelInterview
                      ? "It's recorded on the audit trail. Scheduling a new round is a separate step."
                      : "It's recorded on the audit trail and can be undone from triage within a short window."}
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

              {/* IRIS-B2 — the EXACT resolved set + confirm-N gate for bulk actions. */}
              {isBulk && previewQuery.data && !previewQuery.isLoading && !previewQuery.error ? (
                affectedCount === 0 ? (
                  <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5">
                    <p className="text-sm text-neutral-600">
                      No candidates match this filter — there is nothing to confirm.
                    </p>
                  </div>
                ) : (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      {affectedCount} candidate{affectedCount === 1 ? "" : "s"} affected
                    </p>
                    <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3 text-sm text-neutral-700">
                      {(affected ?? []).map((a) => (
                        <li key={a.entityId} className="flex gap-2">
                          <span aria-hidden className="text-neutral-300">
                            •
                          </span>
                          {a.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
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
                    execute.isPending ||
                    previewQuery.isLoading ||
                    Boolean(previewQuery.error) ||
                    bulkEmpty
                  }
                >
                  {execute.isPending
                    ? "Working…"
                    : `${
                        isDestructive
                          ? isCancelInterview
                            ? "Confirm cancel"
                            : "Confirm reject"
                          : "Confirm"
                      }${isBulk ? ` (${affectedCount})` : ""}`}
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
              {result.total != null ? (
                <p className="mt-1 text-xs text-neutral-500">
                  {result.succeeded ?? 0} of {result.total} succeeded
                  {result.failed ? `, ${result.failed} could not be completed` : ""}.
                </p>
              ) : null}
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
    </div>,
    document.body,
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
