/**
 * C2-F12 — applicability (template assignments), the resolved-configuration
 * preview and named interview loops (Plan A §15 P3 + "resolved configuration
 * preview").
 *
 * Capability gates (C2-F1 — no role lists):
 *   - listTemplateAssignments, previewResolvedConfiguration,
 *     listApplicabilityRequisitions — `settings.applicability_read`
 *     (default admin + hr_head);
 *   - create/update/deleteTemplateAssignment — `settings.applicability_write`
 *     (default admin);
 *   - list/create/updateInterviewLoop — `settings.interview_templates`
 *     (default admin; loops are part of interview-template configuration).
 *   Writes are wrapped in withAudit (the 0136 audit triggers also record the
 *   row change).
 *
 * Writes validate the target template (must be a live template of that kind
 * in this tenant) and every id inside the conditions (must be this tenant's
 * legal entity / BU / location / function / profile). Kinds with no consumer
 * yet have no target table, so they can't be assigned (BAD_REQUEST) — the
 * kind list is ready for F4 / F5 / F6.
 */

import { TRPCError } from "@trpc/server";
import { sql as dsql } from "drizzle-orm";
import {
  DEFAULT_INTERVIEW_LOOP_KEY,
  TEMPLATE_KINDS,
  TEMPLATE_KIND_META,
  createInterviewLoopInputSchema,
  createTemplateAssignmentInputSchema,
  deleteTemplateAssignmentInputSchema,
  deleteTemplateAssignmentOutputSchema,
  interviewLoopMutationOutputSchema,
  listInterviewLoopsInputSchema,
  listInterviewLoopsOutputSchema,
  listApplicabilityRequisitionsInputSchema,
  listApplicabilityRequisitionsOutputSchema,
  listTemplateAssignmentsInputSchema,
  listTemplateAssignmentsOutputSchema,
  parseStoredConditions,
  previewResolvedConfigurationInputSchema,
  previewResolvedConfigurationOutputSchema,
  subjectToPreview,
  templateAssignmentMutationOutputSchema,
  updateInterviewLoopInputSchema,
  updateTemplateAssignmentInputSchema,
  type ApplicabilityConditions,
  type InterviewLoopRow,
  type PreviewKindResult,
  type TemplateAssignmentRow,
  type TemplateKind,
} from "@hireops/api-types";
import {
  buildSubjectFromAttributes,
  ensureDefaultInterviewLoop,
  evaluateKind,
  loadAssignments,
  loadRequisitionAttributes,
  loadTemplateTargets,
  type TemplateTarget,
} from "../lib/applicability";
import { can, requireCapability } from "./permissions";
import { protectedProcedure, type HonoTRPCContext } from "./trpc-core";
import { withAudit } from "./with-audit";

type TxDb = NonNullable<HonoTRPCContext["db"]>;

function asRows<T>(res: unknown): T[] {
  return (res as { rows?: T[] }).rows ?? (res as T[]);
}

type GateCap =
  | "settings.applicability_read"
  | "settings.applicability_write"
  | "settings.interview_templates";

/** C2-F1 — capability gate (no role lists), then the tenant-bound db. */
function gate(ctx: HonoTRPCContext, cap: GateCap, message: string) {
  requireCapability(ctx, cap, message);
  if (!ctx.db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "protected procedure invoked without tenant-bound db",
    });
  }
  if (!ctx.tenantId) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
  }
  return { db: ctx.db, tenantId: ctx.tenantId };
}

const READ = "settings.applicability_read" as const;
const WRITE = "settings.applicability_write" as const;
const LOOPS = "settings.interview_templates" as const;
const READ_MSG = "Template assignments are visible to admin and hr_head only";
const WRITE_MSG = "Managing template assignments is admin-only";

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/** SAVEPOINT + clean BAD_REQUEST on a unique collision (the org-architecture precedent). */
async function guarded<T>(db: TxDb, fn: (tx: TxDb) => Promise<T>, dup: string): Promise<T> {
  try {
    return await db.transaction((tx) => fn(tx));
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505") throw bad(dup);
    if (code === "23514") throw bad("A value is outside the allowed format");
    throw err;
  }
}

async function actorMembership(db: TxDb, ctx: HonoTRPCContext): Promise<string | null> {
  if (!ctx.userId || !ctx.tenantId) return null;
  const [r] = asRows<{ id: string }>(
    await db.execute(dsql`
      SELECT id::text AS id FROM public.tenant_user_memberships
       WHERE user_id = ${ctx.userId}::uuid AND tenant_id = ${ctx.tenantId}::uuid LIMIT 1
    `),
  );
  return r?.id ?? null;
}

// ─────────────────────────── validation ───────────────────────────

const ID_TABLES: Partial<Record<keyof ApplicabilityConditions, { table: string; what: string }>> = {
  legal_entity_id: { table: "legal_entities", what: "Legal entity" },
  business_unit_id: { table: "business_units", what: "Business unit" },
  location_id: { table: "locations", what: "Location" },
  job_function_id: { table: "job_functions", what: "Job function" },
  job_profile_id: { table: "job_profiles", what: "Job profile" },
};

async function assertConditionRefs(db: TxDb, tenantId: string, c: ApplicabilityConditions) {
  for (const [attr, meta] of Object.entries(ID_TABLES) as [
    keyof ApplicabilityConditions,
    { table: string; what: string },
  ][]) {
    const pred = c[attr] as { in: string[] } | undefined;
    if (!pred) continue;
    const ids = [...new Set(pred.in)];
    const rows = asRows<{ n: number }>(
      await db.execute(
        dsql`SELECT count(*)::int AS n FROM ${dsql.raw(`public.${meta.table}`)}
              WHERE tenant_id = ${tenantId}::uuid
                AND id IN (${dsql.join(
                  ids.map((id) => dsql`${id}::uuid`),
                  dsql`, `,
                )})`,
      ),
    );
    if (Number(rows[0]?.n ?? 0) !== ids.length) {
      throw bad(`${meta.what} in the conditions was not found in this organisation`);
    }
  }
}

function assertTarget(targets: TemplateTarget[], kind: TemplateKind, templateId: string) {
  if (!TEMPLATE_KIND_META[kind].consumed) {
    throw bad(
      `${TEMPLATE_KIND_META[kind].label} templates can't be assigned yet — nothing consumes that kind`,
    );
  }
  const t = targets.find((x) => x.kind === kind && x.id === templateId);
  if (!t) throw bad(`That ${TEMPLATE_KIND_META[kind].label.toLowerCase()} was not found`);
}

// ─────────────────────────── mapping ───────────────────────────

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function toRow(
  a: Awaited<ReturnType<typeof loadAssignments>>[number],
  targets: TemplateTarget[],
): TemplateAssignmentRow {
  const parsed = parseStoredConditions(a.conditions);
  const t = targets.find((x) => x.kind === a.templateKind && x.id === a.templateId);
  return {
    id: a.id,
    templateKind: a.templateKind,
    name: a.name,
    templateId: a.templateId,
    templateLabel: t?.label ?? null,
    templateProblem: t ? t.problem : "the target template no longer exists",
    priority: a.priority,
    isActive: a.isActive,
    conditions: parsed ?? {},
    conditionsMalformed: parsed === null,
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
  };
}

async function readRow(db: TxDb, tenantId: string, id: string): Promise<TemplateAssignmentRow> {
  const all = await loadAssignments(db, tenantId);
  const a = all.find((x) => x.id === id);
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Template assignment not found" });
  return toRow(a, await loadTemplateTargets(db, tenantId));
}

async function loopRows(db: TxDb, tenantId: string): Promise<InterviewLoopRow[]> {
  await ensureDefaultInterviewLoop(db, tenantId);
  const rows = asRows<{
    id: string;
    loop_key: string;
    label: string;
    is_active: boolean;
    rounds: number;
  }>(
    await db.execute(dsql`
      SELECT l.id::text AS id, l.loop_key, l.label, l.is_active,
             (SELECT count(*)::int FROM public.tenant_interview_round_template t
               WHERE t.tenant_id = l.tenant_id AND t.loop_key = l.loop_key) AS rounds
        FROM public.interview_loops l
       WHERE l.tenant_id = ${tenantId}::uuid
       ORDER BY (l.loop_key = ${DEFAULT_INTERVIEW_LOOP_KEY}) DESC, l.label
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    loopKey: r.loop_key,
    label: r.label,
    isActive: r.is_active,
    isDefault: r.loop_key === DEFAULT_INTERVIEW_LOOP_KEY,
    roundCount: Number(r.rounds),
  }));
}

// ─────────────────────────── procedures ───────────────────────────

export const applicabilityProcedures = {
  listTemplateAssignments: protectedProcedure
    .input(listTemplateAssignmentsInputSchema)
    .output(listTemplateAssignmentsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { db, tenantId } = gate(ctx, READ, READ_MSG);
      const targets = await loadTemplateTargets(db, tenantId);
      const assignments = await loadAssignments(db, tenantId, input.templateKind);
      return {
        assignments: assignments.map((a) => toRow(a, targets)),
        targets: targets
          .filter((t) => !input.templateKind || t.kind === input.templateKind)
          .map((t) => ({
            kind: t.kind,
            id: t.id,
            key: t.key,
            label: t.label,
            isActive: t.isActive,
          })),
        canWrite: can(ctx, WRITE),
      };
    }),

  createTemplateAssignment: protectedProcedure
    .input(createTemplateAssignmentInputSchema)
    .output(templateAssignmentMutationOutputSchema)
    .mutation(async ({ ctx, input }) =>
      withAudit("create_template_assignment", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, WRITE, WRITE_MSG);
        const targets = await loadTemplateTargets(db, tenantId);
        assertTarget(targets, input.templateKind, input.templateId);
        await assertConditionRefs(db, tenantId, input.conditions);
        const by = await actorMembership(db, ctx);
        const id = await guarded(
          db,
          async (tx) => {
            const [r] = asRows<{ id: string }>(
              await tx.execute(dsql`
                INSERT INTO public.template_assignments
                  (tenant_id, template_kind, name, template_id, priority, is_active, conditions, updated_by)
                VALUES (${tenantId}::uuid, ${input.templateKind}, ${input.name},
                        ${input.templateId}::uuid, ${input.priority}, ${input.isActive},
                        ${JSON.stringify(input.conditions)}::jsonb, ${by}::uuid)
                RETURNING id::text AS id
              `),
            );
            return r?.id as string;
          },
          `An assignment named "${input.name}" already exists for this kind`,
        );
        return { row: await readRow(db, tenantId, id) };
      }),
    ),

  updateTemplateAssignment: protectedProcedure
    .input(updateTemplateAssignmentInputSchema)
    .output(templateAssignmentMutationOutputSchema)
    .mutation(async ({ ctx, input }) =>
      withAudit("update_template_assignment", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, WRITE, WRITE_MSG);
        const current = (await loadAssignments(db, tenantId)).find((a) => a.id === input.id);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Template assignment not found" });
        }
        const targets = await loadTemplateTargets(db, tenantId);
        assertTarget(targets, current.templateKind, input.templateId);
        await assertConditionRefs(db, tenantId, input.conditions);
        const by = await actorMembership(db, ctx);
        await guarded(
          db,
          (tx) =>
            tx.execute(dsql`
              UPDATE public.template_assignments
                 SET name = ${input.name}, template_id = ${input.templateId}::uuid,
                     priority = ${input.priority}, is_active = ${input.isActive},
                     conditions = ${JSON.stringify(input.conditions)}::jsonb,
                     updated_by = ${by}::uuid, updated_at = now()
               WHERE tenant_id = ${tenantId}::uuid AND id = ${input.id}::uuid
            `),
          `An assignment named "${input.name}" already exists for this kind`,
        );
        return { row: await readRow(db, tenantId, input.id) };
      }),
    ),

  deleteTemplateAssignment: protectedProcedure
    .input(deleteTemplateAssignmentInputSchema)
    .output(deleteTemplateAssignmentOutputSchema)
    .mutation(async ({ ctx, input }) =>
      withAudit("delete_template_assignment", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, WRITE, WRITE_MSG);
        const rows = asRows<{ id: string }>(
          await db.execute(dsql`
            DELETE FROM public.template_assignments
             WHERE tenant_id = ${tenantId}::uuid AND id = ${input.id}::uuid
            RETURNING id::text AS id
          `),
        );
        return { deleted: rows.length > 0 };
      }),
    ),

  /**
   * previewResolvedConfiguration — for a requisition (or a what-if attribute
   * set): per kind, the winning assignment + the predicates that matched, the
   * ties, every assignment's evaluation, and the fallback when nothing matches.
   */
  previewResolvedConfiguration: protectedProcedure
    .input(previewResolvedConfigurationInputSchema)
    .output(previewResolvedConfigurationOutputSchema)
    .query(async ({ ctx, input }) => {
      const { db, tenantId } = gate(ctx, READ, READ_MSG);
      const subject = input.requisitionId
        ? await loadRequisitionAttributes(db, tenantId, input.requisitionId)
        : await buildSubjectFromAttributes(db, tenantId, input.attributes ?? {});
      if (!subject) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      const targets = await loadTemplateTargets(db, tenantId);
      const all = await loadAssignments(db, tenantId);
      const kinds: PreviewKindResult[] = [];
      for (const kind of TEMPLATE_KINDS) {
        const meta = TEMPLATE_KIND_META[kind];
        const res = await evaluateKind(db, tenantId, kind, subject, {
          targets,
          assignments: all.filter((a) => a.templateKind === kind),
        });
        const w = res.winner;
        kinds.push({
          kind,
          label: meta.label,
          consumed: meta.consumed,
          winner: w
            ? {
                assignmentId: w.assignmentId,
                name: w.name,
                templateId: w.templateId,
                templateLabel:
                  targets.find((t) => t.kind === kind && t.id === w.templateId)?.label ?? null,
                matchedPredicates: w.matchedPredicates,
                isDefault: w.isDefault,
                priority: w.priority,
              }
            : null,
          ties: (w?.ties ?? []).map((t) => ({ assignmentId: t.assignmentId, name: t.name })),
          fallback: meta.fallback,
          evaluated: res.evaluated.map((e) => ({
            assignmentId: e.assignmentId,
            name: e.name,
            matches: e.matches,
            matchedPredicates: e.matchedPredicates,
            failedPredicates: e.failedPredicates,
            skippedReason: e.skippedReason,
          })),
        });
      }
      return {
        requisitionId: input.requisitionId ?? null,
        subject: subjectToPreview(subject),
        kinds,
      };
    }),

  /** Requisitions to test the rules against (latest 100, optional title search). */
  listApplicabilityRequisitions: protectedProcedure
    .input(listApplicabilityRequisitionsInputSchema)
    .output(listApplicabilityRequisitionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { db, tenantId } = gate(ctx, READ, READ_MSG);
      const like = input.search ? `%${input.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = asRows<{ id: string; title: string; status: string }>(
        await db.execute(dsql`
          SELECT r.id::text AS id, p.title, r.status
            FROM public.requisitions r
            JOIN public.positions p ON p.id = r.position_id AND p.tenant_id = r.tenant_id
           WHERE r.tenant_id = ${tenantId}::uuid
             ${like ? dsql`AND p.title ILIKE ${like}` : dsql``}
           ORDER BY r.created_at DESC
           LIMIT 100
        `),
      );
      return { requisitions: rows };
    }),

  // ─────────── named interview loops ───────────

  listInterviewLoops: protectedProcedure
    .input(listInterviewLoopsInputSchema)
    .output(listInterviewLoopsOutputSchema)
    .query(async ({ ctx }) => {
      const { db, tenantId } = gate(ctx, LOOPS, "Interview loops are admin-only");
      return { loops: await loopRows(db, tenantId) };
    }),

  createInterviewLoop: protectedProcedure
    .input(createInterviewLoopInputSchema)
    .output(interviewLoopMutationOutputSchema)
    .mutation(async ({ ctx, input }) =>
      withAudit("create_interview_loop", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, LOOPS, "Managing interview loops is admin-only");
        const by = await actorMembership(db, ctx);
        await guarded(
          db,
          (tx) =>
            tx.execute(dsql`
              INSERT INTO public.interview_loops (tenant_id, loop_key, label, updated_by)
              VALUES (${tenantId}::uuid, ${input.loopKey}, ${input.label}, ${by}::uuid)
            `),
          `A loop with key "${input.loopKey}" already exists`,
        );
        const row = (await loopRows(db, tenantId)).find((l) => l.loopKey === input.loopKey);
        if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "loop not saved" });
        return { row };
      }),
    ),

  /** Relabel / (de)activate a loop. The key is immutable; the default loop stays active. */
  updateInterviewLoop: protectedProcedure
    .input(updateInterviewLoopInputSchema)
    .output(interviewLoopMutationOutputSchema)
    .mutation(async ({ ctx, input }) =>
      withAudit("update_interview_loop", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, LOOPS, "Managing interview loops is admin-only");
        const current = (await loopRows(db, tenantId)).find((l) => l.id === input.id);
        if (!current)
          throw new TRPCError({ code: "NOT_FOUND", message: "Interview loop not found" });
        if (current.isDefault && !input.isActive) {
          throw bad("The default loop is the fallback and can't be deactivated");
        }
        const by = await actorMembership(db, ctx);
        await db.execute(dsql`
          UPDATE public.interview_loops
             SET label = ${input.label}, is_active = ${input.isActive},
                 updated_by = ${by}::uuid, updated_at = now()
           WHERE tenant_id = ${tenantId}::uuid AND id = ${input.id}::uuid
        `);
        const row = (await loopRows(db, tenantId)).find((l) => l.id === input.id);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview loop not found" });
        return { row };
      }),
    ),
};
