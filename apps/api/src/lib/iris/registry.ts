/**
 * Iris — user-invoked TRANSACTIONAL assistant (IRIS-A1). WHITELIST-ONLY action
 * registry for the menu-driven path.
 *
 * HONESTY. This registry is the ONLY thing `irisExecute` can dispatch through:
 * a caller can never ask Iris to invoke an arbitrary procedure. Each action's
 * `execute` runs the SAME gated tRPC procedures a human uses, via the in-process
 * `appRouter.createCaller(ctx)` caller (exactly what the portal's server-side
 * caller does — apps/internal-portal/src/lib/trpc-server.ts). Those procedures
 * keep their own RLS + `withAudit`; Iris only ORCHESTRATES them and records one
 * provenance row. There is NO side write-path here.
 *
 * The registry is stored as type-ERASED entries (`AnyIrisAction`, `unknown` at
 * the boundary) so the heterogeneous map needs no `any` (a hard lint gate). Each
 * concrete action keeps its precise `IrisAction<P>` typing; `eraseIrisAction`
 * closes over the concrete P at registration so params round-trip type-safely
 * (parse → execute) without leaking P into the registry's public type.
 */

import type { z } from "zod";
import type {
  CreateRequisitionDraftInput,
  CreateRequisitionDraftOutput,
  GenerateJdDraftInput,
  GenerateJdDraftOutput,
  AdvanceApplicationInput,
  AdvanceApplicationOutput,
  RejectApplicationInput,
  RejectApplicationOutput,
  CreateOnboardingCaseForApplicationInput,
  CreateOnboardingCaseForApplicationOutput,
  ListCandidatesByRequisitionInput,
  ListCandidatesByRequisitionOutput,
  MessageCandidateInput,
  MessageCandidateOutput,
  SetRequisitionHoldInput,
  SetRequisitionHoldOutput,
} from "@hireops/api-types";
import type { HonoTRPCContext } from "../../trpc/trpc-core";
import { createRequisitionJdAction } from "./actions/create-requisition-jd";
import { advanceApplicationAction } from "./actions/advance-application";
import { rejectApplicationAction } from "./actions/reject-application";
import { openOnboardingCaseAction } from "./actions/open-onboarding-case";
import { bulkAdvanceApplicationsAction } from "./actions/bulk-advance-applications";
import { bulkRejectApplicationsAction } from "./actions/bulk-reject-applications";
import { messageCandidateAction } from "./actions/message-candidate";
import { holdRequisitionAction } from "./actions/hold-requisition";
import { resumeRequisitionAction } from "./actions/resume-requisition";

/**
 * The subset of the in-process tRPC caller (appRouter.createCaller(ctx)) that
 * the registered actions invoke.
 *
 * This is DELIBERATELY a structural subset rather than
 * `ReturnType<typeof appRouter.createCaller>`: the registry is imported BY the
 * router, so referencing the router's own inferred type here would make
 * appRouter circularly reference itself (tsc TS7022). The REAL caller is a
 * superset and assigns to this interface, so an action still calls the REAL
 * gated procedure (its RLS + withAudit fire) with fully-typed args. Each method
 * mirrors a procedure's api-types input/output exactly — add one here when a new
 * action needs another procedure.
 */
export interface IrisCaller {
  createRequisitionDraft(input: CreateRequisitionDraftInput): Promise<CreateRequisitionDraftOutput>;
  generateJdDraft(input: GenerateJdDraftInput): Promise<GenerateJdDraftOutput>;
  advanceApplication(input: AdvanceApplicationInput): Promise<AdvanceApplicationOutput>;
  rejectApplication(input: RejectApplicationInput): Promise<RejectApplicationOutput>;
  createOnboardingCaseForApplication(
    input: CreateOnboardingCaseForApplicationInput,
  ): Promise<CreateOnboardingCaseForApplicationOutput>;
  listCandidatesByRequisition(
    input: ListCandidatesByRequisitionInput,
  ): Promise<ListCandidatesByRequisitionOutput>;
  messageCandidate(input: MessageCandidateInput): Promise<MessageCandidateOutput>;
  setRequisitionHold(input: SetRequisitionHoldInput): Promise<SetRequisitionHoldOutput>;
}

/** The (entityType, entityId, human summary) a SINGLE-entity action reports after
 * it commits. */
export interface IrisSingleActionResult {
  entityType: string;
  entityId: string | null;
  resultSummary: string;
}

/**
 * What a FILTER-based BULK action (IRIS-B2) reports after it loops the real
 * per-entity gated procedure over the resolved set. `entityIds` are the entities
 * that COMMITTED (one provenance row is recorded per id upstream); `total /
 * succeeded / failed` report the batch outcome so partial failure is surfaced
 * honestly rather than swallowed.
 */
export interface IrisBulkActionResult {
  entityType: string;
  entityIds: string[];
  resultSummary: string;
  total: number;
  succeeded: number;
  failed: number;
}

/** A single OR bulk action's committed result. `irisExecute` discriminates on
 * the presence of `entityIds` (bulk) vs `entityId` (single). */
export type IrisActionResult = IrisSingleActionResult | IrisBulkActionResult;

/** Narrow an action result to the bulk shape (has `entityIds`). */
export function isBulkActionResult(result: IrisActionResult): result is IrisBulkActionResult {
  return "entityIds" in result;
}

/** One concrete entity a filter-based bulk action resolves to (id + human label). */
export interface IrisResolvedEntity {
  entityId: string;
  label: string;
}

/** The affected set a bulk action's `resolve` reports for the pre-confirm preview. */
export interface IrisResolveResult {
  entityType: string;
  entities: IrisResolvedEntity[];
}

/** A resolved preview shown to the user BEFORE they confirm (client-enforced). */
export interface IrisActionPreview {
  summary: string;
  details: string[];
}

/**
 * A single whitelisted Iris action. `inputSchema` validates `params` server-side
 * (the transport hands `params` as `unknown`); `execute` orchestrates the real
 * gated procedures through `caller` and reports what it created.
 */
export interface IrisAction<P> {
  id: string;
  label: string;
  group: string;
  /**
   * The roles a human needs to perform this action in the app — the SAME
   * app-surface role set, mirrored at the Iris layer (IRIS-B1.1). Iris gates
   * each action per-action against these (irisListActions filters by them;
   * irisPreview/irisExecute enforce them), so a persona sees + can run exactly
   * the actions they could do by hand. This is NOT a new gate on the underlying
   * write — the dispatched procedures keep their own RLS + audit unchanged.
   */
  roles: string[];
  inputSchema: z.ZodType<P>;
  destructive: boolean;
  bulk: boolean;
  buildPreview(params: P): IrisActionPreview;
  /**
   * FILTER-based bulk actions (IRIS-B2) resolve their filter `params` to the
   * concrete affected entities (id + human label) BEFORE confirm, so the preview
   * shows the exact set + count. Single-entity actions leave this undefined.
   */
  resolve?(caller: IrisCaller, ctx: HonoTRPCContext, params: P): Promise<IrisResolveResult>;
  execute(caller: IrisCaller, ctx: HonoTRPCContext, params: P): Promise<IrisActionResult>;
}

/**
 * A type-ERASED action as stored in the registry: the same behaviour with
 * `unknown` at the boundary. `parse` validates raw transport params against the
 * action's schema (throws ZodError on invalid) and returns the parsed value,
 * which callers thread into `buildPreview` / `execute`.
 */
export interface AnyIrisAction {
  id: string;
  label: string;
  group: string;
  /** The app-surface roles that may run this action (IRIS-B1.1). */
  roles: string[];
  destructive: boolean;
  bulk: boolean;
  parse(rawParams: unknown): unknown;
  buildPreview(params: unknown): IrisActionPreview;
  /** Present only for filter-based bulk actions (IRIS-B2); see IrisAction.resolve. */
  resolve?(caller: IrisCaller, ctx: HonoTRPCContext, params: unknown): Promise<IrisResolveResult>;
  execute(caller: IrisCaller, ctx: HonoTRPCContext, params: unknown): Promise<IrisActionResult>;
}

/** Close over a concrete action's P to expose it through the erased boundary. */
function eraseIrisAction<P>(action: IrisAction<P>): AnyIrisAction {
  // Capture the optional resolver once so the erased closure needs no non-null
  // assertion (the concrete P is closed over at registration).
  const resolve = action.resolve;
  return {
    id: action.id,
    label: action.label,
    group: action.group,
    roles: action.roles,
    destructive: action.destructive,
    bulk: action.bulk,
    parse: (rawParams) => action.inputSchema.parse(rawParams),
    buildPreview: (params) => action.buildPreview(params as P),
    // Preserve `resolve` only when the concrete action defines it (bulk actions),
    // closing over the same concrete P (and the captured fn) so the erased
    // boundary stays type-safe without a non-null assertion.
    ...(resolve ? { resolve: (caller, ctx, params) => resolve(caller, ctx, params as P) } : {}),
    execute: (caller, ctx, params) => action.execute(caller, ctx, params as P),
  };
}

/**
 * The whitelist. `irisExecute` looks an action up here by id and refuses
 * anything absent. Add a new action by importing it and registering it below —
 * nothing else can widen what Iris can do.
 */
export const IRIS_ACTIONS: Record<string, AnyIrisAction> = Object.fromEntries(
  // Erase each action at its OWN concrete P (a heterogeneous array of
  // IrisAction<P> would defeat eraseIrisAction's single-P inference), then key
  // the resulting AnyIrisAction entries by id.
  [
    eraseIrisAction(createRequisitionJdAction),
    eraseIrisAction(advanceApplicationAction),
    eraseIrisAction(rejectApplicationAction),
    eraseIrisAction(openOnboardingCaseAction),
    eraseIrisAction(bulkAdvanceApplicationsAction),
    eraseIrisAction(bulkRejectApplicationsAction),
    eraseIrisAction(messageCandidateAction),
    eraseIrisAction(holdRequisitionAction),
    eraseIrisAction(resumeRequisitionAction),
  ].map((a) => [a.id, a]),
);

/** One serialisable menu entry — the minimal shape the menu path renders. */
export interface IrisActionMenuEntry {
  id: string;
  label: string;
  group: string;
  /** The app-surface roles that may run this action (IRIS-B1.1). */
  roles: string[];
  destructive: boolean;
  bulk: boolean;
}

/**
 * The serialisable, whitelist-only menu: exactly the registry, projected to the
 * fields a client needs to render the menu. Carries no zod / no server code.
 */
export function listIrisActions(): IrisActionMenuEntry[] {
  return Object.values(IRIS_ACTIONS).map((a) => ({
    id: a.id,
    label: a.label,
    group: a.group,
    roles: a.roles,
    destructive: a.destructive,
    bulk: a.bulk,
  }));
}

/** Look an action up by id. Returns undefined for anything not whitelisted. */
export function getIrisAction(id: string): AnyIrisAction | undefined {
  return IRIS_ACTIONS[id];
}
