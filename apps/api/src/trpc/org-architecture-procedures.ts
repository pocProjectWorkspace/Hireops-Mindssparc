/**
 * C1-F3 — organisation + job architecture + tenant lookup procedures
 * (Plan A F3, §15 P1/P2).
 *
 * Kept out of router.ts and SPREAD into appRouter (flat names, HANDOVER #31),
 * the scheduling-procedures precedent.
 *
 * Roles:
 *   - getOrgAndJobArchitecture (active rows) — the requisition pickers:
 *     admin, hr_head, hiring_manager, recruiter. `includeInactive` (the admin
 *     pages) is admin + hr_head only.
 *   - listTenantLookups — admin + hr_head (read).
 *   - every write — admin only, wrapped in withAudit; the 0133 audit trigger
 *     also records the row change.
 *
 * All DB work goes through ctx.db (the RLS-bound tx) with an explicit tenant
 * predicate as well. Nothing is ever hard-deleted: rows are deactivated
 * (positions / requisitions / comp bands RESTRICT-FK them). Unique collisions
 * and foreign ids surface as clean BAD_REQUESTs; inserts that can collide run
 * in a SAVEPOINT so the outer RLS tx survives (the createCompBand precedent).
 */

import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import {
  businessUnits,
  jdTemplates,
  jobFunctions,
  jobLevels,
  jobProfiles,
  legalEntities,
  locations,
  tenantLookups,
} from "@hireops/db";
import {
  COUNTRY_CALLING_CODES,
  PLATFORM_LOOKUP_DEFAULTS,
  TENANT_LOOKUP_KINDS,
  TENANT_LOOKUP_KIND_META,
  createJobFunctionInputSchema,
  createJobLevelInputSchema,
  createJobProfileInputSchema,
  createLegalEntityInputSchema,
  createLocationInputSchema,
  getOrgAndJobArchitectureInputSchema,
  getOrgAndJobArchitectureOutputSchema,
  getTenantDefaultCountryInputSchema,
  getTenantDefaultCountryOutputSchema,
  jobFunctionMutationOutputSchema,
  jobLevelMutationOutputSchema,
  jobProfileCompetenciesSchema,
  jobProfileMutationOutputSchema,
  legalEntityMutationOutputSchema,
  listTenantLookupsInputSchema,
  listTenantLookupsOutputSchema,
  locationMutationOutputSchema,
  resetTenantLookupInputSchema,
  resetTenantLookupOutputSchema,
  resolvePreJoiningEngagementSettings,
  resolveTenantDefaultCountry,
  resolveTenantLookup,
  setBusinessUnitLegalEntityInputSchema,
  setBusinessUnitLegalEntityOutputSchema,
  setTenantDefaultCountryInputSchema,
  setTenantDefaultCountryOutputSchema,
  updateJobFunctionInputSchema,
  updateJobLevelInputSchema,
  updateJobProfileInputSchema,
  updateLegalEntityInputSchema,
  updateLocationInputSchema,
  upsertTenantLookupInputSchema,
  upsertTenantLookupOutputSchema,
  type JobFunctionRow,
  type JobLevelRow,
  type JobProfileRow,
  type LegalEntityRow,
  type LocationRow,
  type OrgBusinessUnitRow,
  type TenantLookupDefault,
  type TenantLookupKind,
  type TenantLookupKindView,
} from "@hireops/api-types";
import { protectedProcedure, type HonoTRPCContext } from "./trpc-core";
import { withAudit } from "./with-audit";

type TxDb = NonNullable<HonoTRPCContext["db"]>;

/** Pickers in the requisition wizard (same set that reads business units + bands) + hr_head. */
export const ORG_ARCH_PICKER_ROLES = new Set(["admin", "hr_head", "hiring_manager", "recruiter"]);
/** The admin pages read inactive rows too. */
export const ORG_ARCH_READ_ROLES = new Set(["admin", "hr_head"]);
/** Every write. */
export const ORG_ARCH_WRITE_ROLES = new Set(["admin"]);

const WRITE_MESSAGE = "Managing the organisation and job architecture is admin-only";

function requireAnyRole(ctx: HonoTRPCContext, allowed: Set<string>, message: string): void {
  if (!ctx.roles.some((r) => allowed.has(r))) throw new TRPCError({ code: "FORBIDDEN", message });
}

function gate(ctx: HonoTRPCContext, allowed: Set<string>, message: string) {
  requireAnyRole(ctx, allowed, message);
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

function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/**
 * Run a write in a SAVEPOINT and translate the expected Postgres failures
 * (unique / FK / check) into BAD_REQUESTs instead of aborting the request tx.
 */
async function guardedWrite<T>(db: TxDb, fn: (tx: TxDb) => Promise<T>, dupMessage: string) {
  try {
    return await db.transaction((tx) => fn(tx));
  } catch (err) {
    const code = pgCode(err);
    if (code === "23505") throw new TRPCError({ code: "BAD_REQUEST", message: dupMessage });
    if (code === "23503") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A referenced record was not found in this organisation",
      });
    }
    if (code === "23514") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A value is outside the allowed format",
      });
    }
    throw err;
  }
}

function notFound(what: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
}

// ─────────────────────────── row mappers ───────────────────────────

const legalEntityToApi = (r: typeof legalEntities.$inferSelect): LegalEntityRow => ({
  id: r.id,
  name: r.name,
  countryCode: r.countryCode,
  isActive: r.isActive,
});

const locationToApi = (r: typeof locations.$inferSelect): LocationRow => ({
  id: r.id,
  name: r.name,
  city: r.city ?? null,
  region: r.region ?? null,
  countryCode: r.countryCode,
  legalEntityId: r.legalEntityId ?? null,
  timezone: r.timezone ?? null,
  isActive: r.isActive,
});

const businessUnitToApi = (r: typeof businessUnits.$inferSelect): OrgBusinessUnitRow => ({
  id: r.id,
  name: r.name,
  parentBusinessUnitId: r.parentBusinessUnitId ?? null,
  legalEntityId: r.legalEntityId ?? null,
  isArchived: r.isArchived,
});

const jobFunctionToApi = (r: typeof jobFunctions.$inferSelect): JobFunctionRow => ({
  id: r.id,
  key: r.key,
  label: r.label,
  sortOrder: r.sortOrder,
  isActive: r.isActive,
});

const jobLevelToApi = (r: typeof jobLevels.$inferSelect): JobLevelRow => ({
  id: r.id,
  key: r.key,
  label: r.label,
  rank: r.rank,
  isActive: r.isActive,
});

function jobProfileToApi(r: typeof jobProfiles.$inferSelect): JobProfileRow {
  // A malformed competencies blob reads as [] rather than failing the read.
  const comps = jobProfileCompetenciesSchema.safeParse(r.competencies);
  return {
    id: r.id,
    title: r.title,
    jobFunctionId: r.jobFunctionId ?? null,
    jobLevelMinId: r.jobLevelMinId ?? null,
    jobLevelMaxId: r.jobLevelMaxId ?? null,
    defaultJdTemplateId: r.defaultJdTemplateId ?? null,
    competencies: comps.success ? comps.data : [],
    canonicalMarketTitle: r.canonicalMarketTitle ?? null,
    isActive: r.isActive,
  };
}

// ─────────────────────────── shared validation ───────────────────────────

async function assertLegalEntity(db: TxDb, tenantId: string, id: string | null | undefined) {
  if (!id) return;
  const [r] = await db
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.id, id)))
    .limit(1);
  if (!r) throw new TRPCError({ code: "BAD_REQUEST", message: "Legal entity not found" });
}

/** Profile references: function, level range (min.rank ≤ max.rank), JD template. */
async function assertProfileRefs(
  db: TxDb,
  tenantId: string,
  input: {
    jobFunctionId?: string | null;
    jobLevelMinId?: string | null;
    jobLevelMaxId?: string | null;
    defaultJdTemplateId?: string | null;
  },
) {
  const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
  if (input.jobFunctionId) {
    const [r] = await db
      .select({ id: jobFunctions.id })
      .from(jobFunctions)
      .where(and(eq(jobFunctions.tenantId, tenantId), eq(jobFunctions.id, input.jobFunctionId)))
      .limit(1);
    if (!r) throw bad("Job function not found");
  }
  const rankOf = async (id: string) => {
    const [r] = await db
      .select({ rank: jobLevels.rank })
      .from(jobLevels)
      .where(and(eq(jobLevels.tenantId, tenantId), eq(jobLevels.id, id)))
      .limit(1);
    if (!r) throw bad("Job level not found");
    return r.rank;
  };
  const minRank = input.jobLevelMinId ? await rankOf(input.jobLevelMinId) : null;
  const maxRank = input.jobLevelMaxId ? await rankOf(input.jobLevelMaxId) : null;
  if (minRank !== null && maxRank !== null && minRank > maxRank) {
    throw bad("The lowest level must not rank above the highest level");
  }
  if (input.defaultJdTemplateId) {
    const [r] = await db
      .select({ id: jdTemplates.id })
      .from(jdTemplates)
      .where(and(eq(jdTemplates.tenantId, tenantId), eq(jdTemplates.id, input.defaultJdTemplateId)))
      .limit(1);
    if (!r) throw bad("JD template not found");
  }
}

/**
 * The base list a kind resolves over. Every kind uses the platform default,
 * EXCEPT renege_reason: PC-17 already lets a tenant edit renege reasons in
 * settings.preJoiningEngagement, so that (resolved) list is the base — the same
 * fallback resolveRenegeReasons uses at runtime, so the Lists page shows
 * exactly what the renege flow offers.
 */
async function lookupBase(
  ctx: HonoTRPCContext,
  tenantId: string,
  kind: TenantLookupKind,
): Promise<TenantLookupDefault[]> {
  if (kind !== "renege_reason") return PLATFORM_LOOKUP_DEFAULTS[kind];
  const [row] = await ctx.sql<{ settings: Record<string, unknown> | null }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const reasons = resolvePreJoiningEngagementSettings(
    row?.settings?.preJoiningEngagement,
  ).renegeReasons;
  return reasons.map((r, i) => ({ key: r.code, label: r.label, sortOrder: (i + 1) * 10 }));
}

function kindView(
  kind: TenantLookupKind,
  rows: Parameters<typeof resolveTenantLookup>[1],
  base: TenantLookupDefault[],
): TenantLookupKindView {
  const meta = TENANT_LOOKUP_KIND_META[kind];
  return {
    kind,
    label: meta.label,
    description: meta.description,
    attrsHint: meta.attrsHint,
    entries: resolveTenantLookup(kind, rows, { base }),
  };
}

async function lookupKindView(
  ctx: HonoTRPCContext,
  db: TxDb,
  tenantId: string,
  kind: TenantLookupKind,
): Promise<TenantLookupKindView> {
  const rows = await db
    .select()
    .from(tenantLookups)
    .where(and(eq(tenantLookups.tenantId, tenantId), eq(tenantLookups.kind, kind)));
  return kindView(kind, rows, await lookupBase(ctx, tenantId, kind));
}

// ─────────────────────────── procedures ───────────────────────────

export const orgArchitectureProcedures = {
  /**
   * getOrgAndJobArchitecture — one read for every picker and the admin pages:
   * entities, locations, business units (with entity), functions, levels (by
   * rank), profiles, and the requisition lookups (employment / requisition
   * type, active, platform default + tenant value). Active only unless
   * `includeInactive` (admin + hr_head).
   */
  getOrgAndJobArchitecture: protectedProcedure
    .input(getOrgAndJobArchitectureInputSchema)
    .output(getOrgAndJobArchitectureOutputSchema)
    .query(async ({ ctx, input }) => {
      const { db, tenantId } = gate(
        ctx,
        ORG_ARCH_PICKER_ROLES,
        "The organisation and job architecture require the admin, hr_head, hiring_manager or recruiter role",
      );
      const all = input.includeInactive === true;
      if (all) {
        requireAnyRole(
          ctx,
          ORG_ARCH_READ_ROLES,
          "Inactive organisation records are visible to admin and hr_head only",
        );
      }
      const [ents, locs, bus, fns, lvls, profs, lookupRows] = await Promise.all([
        db
          .select()
          .from(legalEntities)
          .where(
            all
              ? eq(legalEntities.tenantId, tenantId)
              : and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.isActive, true)),
          )
          .orderBy(asc(legalEntities.name)),
        db
          .select()
          .from(locations)
          .where(
            all
              ? eq(locations.tenantId, tenantId)
              : and(eq(locations.tenantId, tenantId), eq(locations.isActive, true)),
          )
          .orderBy(asc(locations.countryCode), asc(locations.name)),
        db
          .select()
          .from(businessUnits)
          .where(
            all
              ? eq(businessUnits.tenantId, tenantId)
              : and(eq(businessUnits.tenantId, tenantId), eq(businessUnits.isArchived, false)),
          )
          .orderBy(asc(businessUnits.name)),
        db
          .select()
          .from(jobFunctions)
          .where(
            all
              ? eq(jobFunctions.tenantId, tenantId)
              : and(eq(jobFunctions.tenantId, tenantId), eq(jobFunctions.isActive, true)),
          )
          .orderBy(asc(jobFunctions.sortOrder), asc(jobFunctions.label)),
        db
          .select()
          .from(jobLevels)
          .where(
            all
              ? eq(jobLevels.tenantId, tenantId)
              : and(eq(jobLevels.tenantId, tenantId), eq(jobLevels.isActive, true)),
          )
          .orderBy(asc(jobLevels.rank), asc(jobLevels.key)),
        db
          .select()
          .from(jobProfiles)
          .where(
            all
              ? eq(jobProfiles.tenantId, tenantId)
              : and(eq(jobProfiles.tenantId, tenantId), eq(jobProfiles.isActive, true)),
          )
          .orderBy(asc(jobProfiles.title)),
        db.select().from(tenantLookups).where(eq(tenantLookups.tenantId, tenantId)),
      ]);
      return {
        legalEntities: ents.map(legalEntityToApi),
        locations: locs.map(locationToApi),
        businessUnits: bus.map(businessUnitToApi),
        jobFunctions: fns.map(jobFunctionToApi),
        jobLevels: lvls.map(jobLevelToApi),
        jobProfiles: profs.map(jobProfileToApi),
        lookups: {
          employmentType: resolveTenantLookup("employment_type", lookupRows, { activeOnly: true }),
          requisitionType: resolveTenantLookup("requisition_type", lookupRows, {
            activeOnly: true,
          }),
        },
      };
    }),

  // ── legal entities ──
  createLegalEntity: protectedProcedure
    .input(createLegalEntityInputSchema)
    .output(legalEntityMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("create_legal_entity", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .insert(legalEntities)
              .values({ tenantId, name: input.name, countryCode: input.countryCode })
              .returning(),
          `A legal entity named "${input.name}" already exists`,
        );
        if (!row) throw notFound("Legal entity");
        return { row: legalEntityToApi(row) };
      }),
    ),

  updateLegalEntity: protectedProcedure
    .input(updateLegalEntityInputSchema)
    .output(legalEntityMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("update_legal_entity", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .update(legalEntities)
              .set({
                name: input.name,
                countryCode: input.countryCode,
                isActive: input.isActive,
                updatedAt: new Date(),
              })
              .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.id, input.id)))
              .returning(),
          `A legal entity named "${input.name}" already exists`,
        );
        if (!row) throw notFound("Legal entity");
        return { row: legalEntityToApi(row) };
      }),
    ),

  // ── locations ──
  createLocation: protectedProcedure
    .input(createLocationInputSchema)
    .output(locationMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("create_location", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        await assertLegalEntity(db, tenantId, input.legalEntityId);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .insert(locations)
              .values({
                tenantId,
                name: input.name,
                city: input.city,
                region: input.region,
                countryCode: input.countryCode,
                legalEntityId: input.legalEntityId ?? null,
                timezone: input.timezone ?? null,
              })
              .returning(),
          `A location named "${input.name}" already exists`,
        );
        if (!row) throw notFound("Location");
        return { row: locationToApi(row) };
      }),
    ),

  updateLocation: protectedProcedure
    .input(updateLocationInputSchema)
    .output(locationMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("update_location", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        await assertLegalEntity(db, tenantId, input.legalEntityId);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .update(locations)
              .set({
                name: input.name,
                city: input.city,
                region: input.region,
                countryCode: input.countryCode,
                legalEntityId: input.legalEntityId ?? null,
                timezone: input.timezone ?? null,
                isActive: input.isActive,
                updatedAt: new Date(),
              })
              .where(and(eq(locations.tenantId, tenantId), eq(locations.id, input.id)))
              .returning(),
          `A location named "${input.name}" already exists`,
        );
        if (!row) throw notFound("Location");
        return { row: locationToApi(row) };
      }),
    ),

  // ── business unit ↔ legal entity ──
  setBusinessUnitLegalEntity: protectedProcedure
    .input(setBusinessUnitLegalEntityInputSchema)
    .output(setBusinessUnitLegalEntityOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("set_business_unit_legal_entity", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        await assertLegalEntity(db, tenantId, input.legalEntityId);
        const [row] = await db
          .update(businessUnits)
          .set({ legalEntityId: input.legalEntityId, updatedAt: new Date() })
          .where(
            and(eq(businessUnits.tenantId, tenantId), eq(businessUnits.id, input.businessUnitId)),
          )
          .returning();
        if (!row) throw notFound("Business unit");
        return { row: businessUnitToApi(row) };
      }),
    ),

  // ── job functions ──
  createJobFunction: protectedProcedure
    .input(createJobFunctionInputSchema)
    .output(jobFunctionMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("create_job_function", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .insert(jobFunctions)
              .values({ tenantId, key: input.key, label: input.label, sortOrder: input.sortOrder })
              .returning(),
          `A job function with key "${input.key}" already exists`,
        );
        if (!row) throw notFound("Job function");
        return { row: jobFunctionToApi(row) };
      }),
    ),

  updateJobFunction: protectedProcedure
    .input(updateJobFunctionInputSchema)
    .output(jobFunctionMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("update_job_function", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const [row] = await db
          .update(jobFunctions)
          .set({
            label: input.label,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
            updatedAt: new Date(),
          })
          .where(and(eq(jobFunctions.tenantId, tenantId), eq(jobFunctions.id, input.id)))
          .returning();
        if (!row) throw notFound("Job function");
        return { row: jobFunctionToApi(row) };
      }),
    ),

  // ── job levels ──
  createJobLevel: protectedProcedure
    .input(createJobLevelInputSchema)
    .output(jobLevelMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("create_job_level", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .insert(jobLevels)
              .values({ tenantId, key: input.key, label: input.label, rank: input.rank })
              .returning(),
          `A job level with key "${input.key}" already exists`,
        );
        if (!row) throw notFound("Job level");
        return { row: jobLevelToApi(row) };
      }),
    ),

  updateJobLevel: protectedProcedure
    .input(updateJobLevelInputSchema)
    .output(jobLevelMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("update_job_level", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const [row] = await db
          .update(jobLevels)
          .set({
            label: input.label,
            rank: input.rank,
            isActive: input.isActive,
            updatedAt: new Date(),
          })
          .where(and(eq(jobLevels.tenantId, tenantId), eq(jobLevels.id, input.id)))
          .returning();
        if (!row) throw notFound("Job level");
        return { row: jobLevelToApi(row) };
      }),
    ),

  // ── job profiles ──
  createJobProfile: protectedProcedure
    .input(createJobProfileInputSchema)
    .output(jobProfileMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("create_job_profile", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        await assertProfileRefs(db, tenantId, input);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .insert(jobProfiles)
              .values({
                tenantId,
                title: input.title,
                jobFunctionId: input.jobFunctionId ?? null,
                jobLevelMinId: input.jobLevelMinId ?? null,
                jobLevelMaxId: input.jobLevelMaxId ?? null,
                defaultJdTemplateId: input.defaultJdTemplateId ?? null,
                competencies: input.competencies,
                canonicalMarketTitle: input.canonicalMarketTitle,
              })
              .returning(),
          `A job profile titled "${input.title}" already exists`,
        );
        if (!row) throw notFound("Job profile");
        return { row: jobProfileToApi(row) };
      }),
    ),

  updateJobProfile: protectedProcedure
    .input(updateJobProfileInputSchema)
    .output(jobProfileMutationOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("update_job_profile", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        await assertProfileRefs(db, tenantId, input);
        const [row] = await guardedWrite(
          db,
          (tx) =>
            tx
              .update(jobProfiles)
              .set({
                title: input.title,
                jobFunctionId: input.jobFunctionId ?? null,
                jobLevelMinId: input.jobLevelMinId ?? null,
                jobLevelMaxId: input.jobLevelMaxId ?? null,
                defaultJdTemplateId: input.defaultJdTemplateId ?? null,
                competencies: input.competencies,
                canonicalMarketTitle: input.canonicalMarketTitle,
                isActive: input.isActive,
                updatedAt: new Date(),
              })
              .where(and(eq(jobProfiles.tenantId, tenantId), eq(jobProfiles.id, input.id)))
              .returning(),
          `A job profile titled "${input.title}" already exists`,
        );
        if (!row) throw notFound("Job profile");
        return { row: jobProfileToApi(row) };
      }),
    ),

  // ── tenant lookups ──
  /** Every kind (or one), resolved: platform default + tenant value, inactive included. */
  listTenantLookups: protectedProcedure
    .input(listTenantLookupsInputSchema)
    .output(listTenantLookupsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { db, tenantId } = gate(
        ctx,
        ORG_ARCH_READ_ROLES,
        "Tenant lists are visible to admin and hr_head",
      );
      const rows = await db
        .select()
        .from(tenantLookups)
        .where(eq(tenantLookups.tenantId, tenantId));
      const kinds = input.kind ? [input.kind] : [...TENANT_LOOKUP_KINDS];
      const views: TenantLookupKindView[] = [];
      for (const kind of kinds) {
        views.push(kindView(kind, rows, await lookupBase(ctx, tenantId, kind)));
      }
      return { kinds: views };
    }),

  /** Create-or-update the tenant's row for (kind, key): an override or a new value. */
  upsertTenantLookup: protectedProcedure
    .input(upsertTenantLookupInputSchema)
    .output(upsertTenantLookupOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("upsert_tenant_lookup", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        await db
          .insert(tenantLookups)
          .values({
            tenantId,
            kind: input.kind,
            key: input.key,
            label: input.label,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
            attrs: input.attrs,
          })
          .onConflictDoUpdate({
            target: [tenantLookups.tenantId, tenantLookups.kind, tenantLookups.key],
            set: {
              label: input.label,
              sortOrder: input.sortOrder,
              isActive: input.isActive,
              attrs: input.attrs,
              updatedAt: new Date(),
            },
          });
        return { kind: await lookupKindView(ctx, db, tenantId, input.kind) };
      }),
    ),

  /**
   * Reset a platform value to its default (deletes the override row). A
   * tenant-only value is never deleted — records may hold its key — so this
   * refuses (deactivate it instead).
   */
  resetTenantLookup: protectedProcedure
    .input(resetTenantLookupInputSchema)
    .output(resetTenantLookupOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("reset_tenant_lookup", ctx, input, async () => {
        const { db, tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const base = await lookupBase(ctx, tenantId, input.kind);
        const isPlatform = base.some((d) => d.key === input.key);
        if (!isPlatform) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Only a platform value can be reset. Deactivate a value your organisation added.",
          });
        }
        await db
          .delete(tenantLookups)
          .where(
            and(
              eq(tenantLookups.tenantId, tenantId),
              eq(tenantLookups.kind, input.kind),
              eq(tenantLookups.key, input.key),
            ),
          );
        return { kind: await lookupKindView(ctx, db, tenantId, input.kind) };
      }),
    ),

  // ── default country (C1-BUGS BUG-5 phone dedup) ──
  /**
   * getTenantDefaultCountry — `tenants.settings.defaultCountry` (resolved: an
   * unknown stored code reads as null) plus the supported country list.
   * admin + hr_head.
   */
  getTenantDefaultCountry: protectedProcedure
    .input(getTenantDefaultCountryInputSchema)
    .output(getTenantDefaultCountryOutputSchema)
    .query(async ({ ctx }) => {
      const { tenantId } = gate(
        ctx,
        ORG_ARCH_READ_ROLES,
        "The organisation settings require the admin or hr_head role",
      );
      const [row] = await ctx.sql<{ settings: Record<string, unknown> | null }[]>`
        SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
      `;
      return {
        defaultCountry: resolveTenantDefaultCountry(row?.settings ?? {}),
        supportedCountries: Object.keys(COUNTRY_CALLING_CODES).sort(),
      };
    }),

  /**
   * setTenantDefaultCountry — admin only, audited. tenants is SELECT-only
   * under RLS, so the write is a service-role top-level jsonb merge (the
   * updateSystemSetup precedent); null removes the key (no default country).
   */
  setTenantDefaultCountry: protectedProcedure
    .input(setTenantDefaultCountryInputSchema)
    .output(setTenantDefaultCountryOutputSchema)
    .mutation(({ ctx, input }) =>
      withAudit("set_tenant_default_country", ctx, input, async () => {
        const { tenantId } = gate(ctx, ORG_ARCH_WRITE_ROLES, WRITE_MESSAGE);
        const code = input.defaultCountry;
        const updated =
          code === null
            ? await ctx.sql`
                UPDATE public.tenants
                   SET settings = COALESCE(settings, '{}'::jsonb) - 'defaultCountry'
                 WHERE id = ${tenantId}
                RETURNING id`
            : await ctx.sql`
                UPDATE public.tenants
                   SET settings = COALESCE(settings, '{}'::jsonb)
                                  || jsonb_build_object('defaultCountry', ${code}::text)
                 WHERE id = ${tenantId}
                RETURNING id`;
        if (updated.length !== 1) throw notFound("Tenant");
        return { defaultCountry: code };
      }),
    ),
};
