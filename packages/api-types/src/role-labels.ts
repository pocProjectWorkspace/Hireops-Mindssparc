/**
 * Role DISPLAY labels (PC-23).
 *
 * A tenant may rename how a role READS ("HR Head" → "TA Lead") without
 * touching the role itself: role KEYS, the JWT `roles` claim, RLS and every
 * permission check are unchanged — this is presentation only. Stored at
 * `tenants.settings.roleLabels` as a partial map (role key → label); any key
 * not overridden falls back to the platform default below, which is exactly
 * the label the portal showed before PC-23.
 *
 * Deliberately a SEPARATE module + settings key from stage / recommendation
 * labels (`tenants.settings.labels`, tenant-labels.ts on the cfg-lite branch)
 * so the two features cannot collide.
 *
 * Pure zod + constants: shared by the API (resolve on read, validate on
 * write) and the portal (user chip, user admin, role pickers).
 */

import { z } from "zod";

/** The internal roles a label can be set for (mirrors INTERNAL_TENANT_ROLES). */
export const ROLE_LABEL_KEYS = [
  "admin",
  "recruiter",
  "hiring_manager",
  "panel_member",
  "hr_ops",
  "people_ops",
  "it_admin",
  "hr_head",
] as const;
export type RoleLabelKey = (typeof ROLE_LABEL_KEYS)[number];

/** Platform default — the labels the portal has always shown. */
export const DEFAULT_ROLE_LABELS: Readonly<Record<RoleLabelKey, string>> = {
  admin: "Admin",
  recruiter: "Recruiter",
  hiring_manager: "Hiring Manager",
  panel_member: "Panel Member",
  hr_ops: "HR Ops",
  people_ops: "People Ops",
  it_admin: "IT Admin",
  hr_head: "HR Head",
};

export const ROLE_LABEL_MAX_CHARS = 40;

export const roleLabelValueSchema = z.string().trim().min(1).max(ROLE_LABEL_MAX_CHARS);

/** The stored override block: any subset of role keys. Unknown keys are rejected on write. */
export const roleLabelsSchema = z
  .object(
    Object.fromEntries(ROLE_LABEL_KEYS.map((k) => [k, roleLabelValueSchema.optional()])) as Record<
      RoleLabelKey,
      z.ZodOptional<typeof roleLabelValueSchema>
    >,
  )
  .strict();
export type RoleLabelOverrides = z.infer<typeof roleLabelsSchema>;

/** A complete map — every role key resolved to its display label. */
export type RoleLabels = Record<RoleLabelKey, string>;

const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_LABEL_KEYS);
export function isRoleLabelKey(v: string): v is RoleLabelKey {
  return ROLE_KEY_SET.has(v);
}

/**
 * Merge a raw stored `roleLabels` block (partial / unknown / absent /
 * malformed) over the platform default. Never throws: an invalid entry is
 * ignored per key, so one bad value cannot blank the others. A label equal to
 * the default after trimming is simply the default.
 */
export function resolveRoleLabels(raw: unknown): RoleLabels {
  const out: RoleLabels = { ...DEFAULT_ROLE_LABELS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRoleLabelKey(k)) continue;
    const parsed = roleLabelValueSchema.safeParse(v);
    if (parsed.success) out[k] = parsed.data;
  }
  return out;
}

/** Only the entries that differ from the platform default — what gets stored. */
export function roleLabelOverridesOf(labels: Partial<Record<string, string>>): RoleLabelOverrides {
  const out: RoleLabelOverrides = {};
  for (const k of ROLE_LABEL_KEYS) {
    const v = labels[k]?.trim();
    if (v && v !== DEFAULT_ROLE_LABELS[k]) out[k] = v.slice(0, ROLE_LABEL_MAX_CHARS);
  }
  return out;
}

/** Title-case a key the map does not know ("partner_admin" → "Partner Admin"). */
function fallbackLabel(role: string): string {
  return role
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) =>
      ["hr", "it", "ai"].includes(w.toLowerCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

/**
 * THE helper every surface uses: the display label for a role key, tenant
 * override first, then platform default, then a title-cased key.
 */
export function roleLabel(role: string | null | undefined, labels?: Partial<RoleLabels>): string {
  if (!role) return "";
  if (isRoleLabelKey(role)) return labels?.[role] ?? DEFAULT_ROLE_LABELS[role];
  return fallbackLabel(role);
}

// ─────────────────────────────── procedures ───────────────────────────────

export const getRoleLabelsInputSchema = z.object({});
export const getRoleLabelsOutputSchema = z.object({
  /** Every role key → its effective display label. */
  labels: z.record(z.string(), z.string()),
  /** Just the tenant overrides (for the admin editor). */
  overrides: roleLabelsSchema,
});
export type GetRoleLabelsOutput = z.infer<typeof getRoleLabelsOutputSchema>;

export const updateRoleLabelsInputSchema = z.object({
  /** Full desired override set; an omitted key reverts to the platform default. */
  overrides: roleLabelsSchema,
});
export const updateRoleLabelsOutputSchema = z.object({
  ok: z.literal(true),
  overrides: roleLabelsSchema,
});
