/**
 * C1-F3 — tenant lookups (Plan A §4 "Shape": TX4, TX5, TX6, TX12, TX13, TX14).
 *
 * Simple lists a tenant can relabel, reorder, switch off or extend, with a
 * PLATFORM DEFAULT list per kind supplied here in code. Resolution is
 * platform default + tenant value: a `tenant_lookups` row whose key matches a
 * platform default OVERRIDES it (label, order, active, attrs); a row with a new
 * key ADDS a tenant-specific value. A tenant with no rows gets the platform
 * list unchanged — the resolver never needs a row to exist and never throws.
 *
 * Keys are the canonical values records store (requisitions.employment_type_key,
 * …) and stay stable for analytics whatever the tenant calls them. Nothing here
 * is client-specific: tenant wording is data, not code.
 *
 * Pure zod + pure functions — the tRPC surface, the admin "Lists" page and the
 * requisition wizard pickers all share these definitions.
 */

import { z } from "zod";
import { PLATFORM_RENEGE_REASONS, type RenegeReason } from "./pre-joining-engagement";

// ─────────────────────────── kinds ───────────────────────────

export const TENANT_LOOKUP_KINDS = [
  "employment_type",
  "requisition_type",
  "requisition_hold_reason",
  "offer_decline_reason",
  "renege_reason",
  "separation_reason",
  "asset_type",
] as const;
export type TenantLookupKind = (typeof TENANT_LOOKUP_KINDS)[number];
export const tenantLookupKindSchema = z.enum(TENANT_LOOKUP_KINDS);

export const TENANT_LOOKUP_KIND_META: Record<
  TenantLookupKind,
  { label: string; description: string; attrsHint: string | null }
> = {
  employment_type: {
    label: "Employment types",
    description: "How the role is employed. Picked on the requisition.",
    attrsHint: "hasDuration (true/false), defaultDurationMonths (number)",
  },
  requisition_type: {
    label: "Requisition types",
    description: "Why the role is being hired (new headcount, replacement, …).",
    attrsHint: null,
  },
  requisition_hold_reason: {
    label: "Requisition hold / freeze reasons",
    description: "Why a requisition is put on hold.",
    attrsHint: null,
  },
  offer_decline_reason: {
    label: "Offer decline reasons",
    description: "Why a candidate declined an offer.",
    attrsHint: null,
  },
  renege_reason: {
    label: "Renege reasons",
    description:
      "Why an accepted candidate did not join. Starts from the renege reasons on the Pre-joining settings page.",
    attrsHint: null,
  },
  separation_reason: {
    label: "Separation reasons",
    description: "Why an employee is leaving (attrition analytics).",
    attrsHint: "initiation (resignation / termination / end_of_contract)",
  },
  asset_type: {
    label: "Asset / IT resource types",
    description: "Equipment and access issued to a new joiner.",
    attrsHint: null,
  },
};

// ─────────────────────────── values ───────────────────────────

export const TENANT_LOOKUP_KEY_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;
export const tenantLookupKeySchema = z.string().trim().regex(TENANT_LOOKUP_KEY_RE, {
  message: "Use lower-case letters, digits and underscores (max 40)",
});

/** attrs: a small flat bag of scalars (no nesting). */
export const tenantLookupAttrsSchema = z
  .record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((v) => Object.keys(v).length <= 20, "At most 20 attributes");
export type TenantLookupAttrs = z.infer<typeof tenantLookupAttrsSchema>;

/** A platform default value (code). */
export interface TenantLookupDefault {
  key: string;
  label: string;
  sortOrder: number;
  attrs?: TenantLookupAttrs;
}

/** A tenant row as the resolver sees it (DB → plain object). */
export interface TenantLookupRowInput {
  id: string;
  kind: string;
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  attrs: Record<string, unknown> | null;
}

export const resolvedLookupEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /**
   * platform = the code default, untouched; override = a platform default the
   * tenant changed; tenant = a value only this tenant has.
   */
  source: z.enum(["platform", "override", "tenant"]),
  /** The tenant_lookups row id (null for an untouched platform default). */
  rowId: z.string().uuid().nullable(),
  /** The platform label, when the key is a platform default (for "reset"). */
  platformLabel: z.string().nullable(),
});
export type ResolvedLookupEntry = z.infer<typeof resolvedLookupEntrySchema>;

const renegeDefaults: TenantLookupDefault[] = PLATFORM_RENEGE_REASONS.map((r, i) => ({
  key: r.code,
  label: r.label,
  sortOrder: (i + 1) * 10,
}));

/**
 * Platform default lists. Generic wording only — a tenant relabels / extends
 * them as data. employment_type keys match offers.contract_type
 * (CONTRACT_TYPES) so a requisition and its offer speak the same key.
 */
export const PLATFORM_LOOKUP_DEFAULTS: Record<TenantLookupKind, TenantLookupDefault[]> = {
  employment_type: [
    {
      key: "full_time",
      label: "Full-time (permanent)",
      sortOrder: 10,
      attrs: { hasDuration: false },
    },
    {
      key: "fixed_term",
      label: "Fixed-term",
      sortOrder: 20,
      attrs: { hasDuration: true, defaultDurationMonths: 12 },
    },
    {
      key: "contract",
      label: "Contract",
      sortOrder: 30,
      attrs: { hasDuration: true, defaultDurationMonths: 12 },
    },
    {
      key: "intern",
      label: "Internship",
      sortOrder: 40,
      attrs: { hasDuration: true, defaultDurationMonths: 6 },
    },
  ],
  requisition_type: [
    { key: "new", label: "New headcount", sortOrder: 10 },
    { key: "replacement", label: "Replacement", sortOrder: 20 },
    { key: "investment", label: "Investment / growth", sortOrder: 30 },
  ],
  requisition_hold_reason: [
    { key: "hiring_freeze", label: "Hiring freeze", sortOrder: 10 },
    { key: "budget_review", label: "Budget under review", sortOrder: 20 },
    { key: "role_redefinition", label: "Role being redefined", sortOrder: 30 },
    { key: "reorganisation", label: "Reorganisation", sortOrder: 40 },
    { key: "hiring_manager_unavailable", label: "Hiring manager unavailable", sortOrder: 50 },
    { key: "other", label: "Other", sortOrder: 90 },
  ],
  offer_decline_reason: [
    { key: "counter_offer", label: "Accepted a counter-offer", sortOrder: 10 },
    { key: "another_offer", label: "Accepted another offer", sortOrder: 20 },
    { key: "compensation", label: "Compensation", sortOrder: 30 },
    { key: "location", label: "Location", sortOrder: 40 },
    { key: "role_fit", label: "Role or level not a fit", sortOrder: 50 },
    { key: "notice_period", label: "Notice period / joining date", sortOrder: 60 },
    { key: "personal", label: "Personal reasons", sortOrder: 70 },
    { key: "other", label: "Other", sortOrder: 90 },
  ],
  renege_reason: renegeDefaults,
  separation_reason: [
    {
      key: "better_opportunity",
      label: "Better opportunity",
      sortOrder: 10,
      attrs: { initiation: "resignation" },
    },
    {
      key: "compensation",
      label: "Compensation",
      sortOrder: 20,
      attrs: { initiation: "resignation" },
    },
    { key: "relocation", label: "Relocation", sortOrder: 30, attrs: { initiation: "resignation" } },
    {
      key: "personal",
      label: "Personal reasons",
      sortOrder: 40,
      attrs: { initiation: "resignation" },
    },
    {
      key: "performance",
      label: "Performance",
      sortOrder: 50,
      attrs: { initiation: "termination" },
    },
    { key: "conduct", label: "Conduct", sortOrder: 60, attrs: { initiation: "termination" } },
    { key: "redundancy", label: "Redundancy", sortOrder: 70, attrs: { initiation: "termination" } },
    {
      key: "end_of_contract",
      label: "End of contract",
      sortOrder: 80,
      attrs: { initiation: "end_of_contract" },
    },
    { key: "retirement", label: "Retirement", sortOrder: 85, attrs: { initiation: "resignation" } },
    { key: "other", label: "Other", sortOrder: 90 },
  ],
  asset_type: [
    { key: "laptop", label: "Laptop", sortOrder: 10 },
    { key: "monitor", label: "Monitor", sortOrder: 20 },
    { key: "headset", label: "Headset", sortOrder: 30 },
    { key: "mobile_phone", label: "Mobile phone", sortOrder: 40 },
    { key: "sim_card", label: "SIM card", sortOrder: 50 },
    { key: "id_card", label: "ID card", sortOrder: 60 },
    { key: "access_card", label: "Access card", sortOrder: 70 },
    { key: "other", label: "Other", sortOrder: 90 },
  ],
};

export function isTenantLookupKind(v: string): v is TenantLookupKind {
  return (TENANT_LOOKUP_KINDS as readonly string[]).includes(v);
}

/** Keep only flat scalar attrs (a corrupt row resolves to {} rather than throwing). */
function scalarAttrs(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * Platform default + tenant value for one kind. `rows` may contain other kinds
 * (filtered here). `base` replaces the platform default list (used by the
 * renege kind, whose fallback is the tenant's existing pre-joining setting).
 * Sorted by sortOrder, then label. Inactive entries are kept unless
 * `activeOnly`. Never throws.
 */
export function resolveTenantLookup(
  kind: TenantLookupKind,
  rows: readonly TenantLookupRowInput[],
  opts: { base?: readonly TenantLookupDefault[]; activeOnly?: boolean } = {},
): ResolvedLookupEntry[] {
  const base = opts.base ?? PLATFORM_LOOKUP_DEFAULTS[kind];
  const byKey = new Map<string, ResolvedLookupEntry>();
  for (const d of base) {
    byKey.set(d.key, {
      key: d.key,
      label: d.label,
      sortOrder: d.sortOrder,
      isActive: true,
      attrs: { ...(d.attrs ?? {}) },
      source: "platform",
      rowId: null,
      platformLabel: d.label,
    });
  }
  for (const r of rows) {
    if (r.kind !== kind) continue;
    const def = byKey.get(r.key);
    if (def && def.source === "platform") {
      byKey.set(r.key, {
        key: r.key,
        label: r.label,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        attrs: { ...def.attrs, ...scalarAttrs(r.attrs) },
        source: "override",
        rowId: r.id,
        platformLabel: def.platformLabel,
      });
    } else {
      byKey.set(r.key, {
        key: r.key,
        label: r.label,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        attrs: scalarAttrs(r.attrs),
        source: "tenant",
        rowId: r.id,
        platformLabel: null,
      });
    }
  }
  const out = [...byKey.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
  );
  return opts.activeOnly ? out.filter((e) => e.isActive) : out;
}

/** Label for a stored key; falls back to the key itself (a retired value still displays). */
export function lookupLabel(
  entries: readonly ResolvedLookupEntry[],
  key: string | null,
): string | null {
  if (!key) return null;
  return entries.find((e) => e.key === key)?.label ?? key;
}

/**
 * PC-17 renege reasons, now read through the lookup. The FALLBACK is the
 * tenant's existing `settings.preJoiningEngagement.renegeReasons` (which itself
 * falls back to PLATFORM_RENEGE_REASONS), so a tenant with no renege_reason
 * lookup rows sees exactly what it saw before. Lookup rows override / add on
 * top of that list; inactive values are dropped. Never returns an empty list
 * (the settings list is the floor), so the renege flow always has a reason.
 */
export function resolveRenegeReasons(
  settingsReasons: readonly RenegeReason[],
  rows: readonly TenantLookupRowInput[],
): RenegeReason[] {
  const own = rows.filter((r) => r.kind === "renege_reason");
  if (own.length === 0) return settingsReasons.map((r) => ({ ...r }));
  const base: TenantLookupDefault[] = settingsReasons.map((r, i) => ({
    key: r.code,
    label: r.label,
    sortOrder: (i + 1) * 10,
  }));
  const resolved = resolveTenantLookup("renege_reason", own, { base, activeOnly: true });
  const out = resolved.map((e) => ({ code: e.key, label: e.label }));
  return out.length > 0 ? out : settingsReasons.map((r) => ({ ...r }));
}

// ─────────────────────────── procedures ───────────────────────────

export const tenantLookupKindViewSchema = z.object({
  kind: tenantLookupKindSchema,
  label: z.string(),
  description: z.string(),
  attrsHint: z.string().nullable(),
  entries: z.array(resolvedLookupEntrySchema),
});
export type TenantLookupKindView = z.infer<typeof tenantLookupKindViewSchema>;

export const listTenantLookupsInputSchema = z
  .object({ kind: tenantLookupKindSchema.optional() })
  .default({});
export type ListTenantLookupsInput = z.infer<typeof listTenantLookupsInputSchema>;
export const listTenantLookupsOutputSchema = z.object({
  kinds: z.array(tenantLookupKindViewSchema),
});
export type ListTenantLookupsOutput = z.infer<typeof listTenantLookupsOutputSchema>;

/** Create-or-update the tenant row for (kind, key) — an override or a new value. */
export const upsertTenantLookupInputSchema = z.object({
  kind: tenantLookupKindSchema,
  key: tenantLookupKeySchema,
  label: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isActive: z.boolean().default(true),
  attrs: tenantLookupAttrsSchema.default({}),
});
export type UpsertTenantLookupInput = z.infer<typeof upsertTenantLookupInputSchema>;
export const upsertTenantLookupOutputSchema = z.object({ kind: tenantLookupKindViewSchema });
export type UpsertTenantLookupOutput = z.infer<typeof upsertTenantLookupOutputSchema>;

/**
 * Reset a PLATFORM value to its default (deletes the tenant override row).
 * A tenant-only value can't be deleted — records may store its key — it is
 * deactivated instead (upsert with isActive false).
 */
export const resetTenantLookupInputSchema = z.object({
  kind: tenantLookupKindSchema,
  key: tenantLookupKeySchema,
});
export type ResetTenantLookupInput = z.infer<typeof resetTenantLookupInputSchema>;
export const resetTenantLookupOutputSchema = upsertTenantLookupOutputSchema;
export type ResetTenantLookupOutput = z.infer<typeof resetTenantLookupOutputSchema>;
