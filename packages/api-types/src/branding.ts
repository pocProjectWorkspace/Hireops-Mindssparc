import { z } from "zod";

/**
 * Tenant theme & branding (AD2).
 *
 * Branding is split across two homes on the `tenants` row, and this module
 * is the single source of truth for both halves:
 *
 *   - `tenants.display_name` (a real COLUMN) — the company name that actually
 *     rebrands the product (candidate-facing chrome reads `tenantDisplayName`
 *     from it; the NovaChem rebrand was a raw `UPDATE display_name`). This is
 *     what makes the tenant read as "NovaChem GCC" rather than "Kyndryl POC".
 *   - `tenants.settings.branding` (a jsonb key) — the cosmetic block: primary
 *     brand colour, logo URL, dark-mode default. Written via the same atomic
 *     `settings || jsonb_build_object(...)` merge `updateTenantAiSettings`
 *     uses, so sibling keys (aiSettings, biasLexicon, …) are preserved.
 *
 * The resolver merges defaults over whatever is stored so a tenant that has
 * never written the block still resolves to a complete, valid config — the
 * chrome must never break on an absent/stale blob.
 */

/** A `#RGB` or `#RRGGBB` hex colour. Case-insensitive. */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The platform's default accent — indigo-600, matching the `brand-600` token. */
export const BRANDING_DEFAULT_PRIMARY_COLOR = "#4f46e5";

export const MAX_DISPLAY_NAME_LEN = 80;
export const MAX_LOGO_URL_LEN = 2048;

/**
 * The jsonb-stored cosmetic half (everything EXCEPT displayName, which is a
 * column). Every field defaults, so `parse({})` yields a complete block.
 */
export const brandingSettingsSchema = z.object({
  primaryColor: z
    .string()
    .regex(HEX_COLOR_RE, "Enter a hex colour like #4F46E5")
    .default(BRANDING_DEFAULT_PRIMARY_COLOR),
  logoUrl: z.string().url().max(MAX_LOGO_URL_LEN).nullable().default(null),
  darkModeDefault: z.boolean().default(false),
});
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;

/** The effective cosmetic block when a tenant has never written it. */
export function defaultBrandingSettings(): BrandingSettings {
  return brandingSettingsSchema.parse({});
}

/**
 * Merge a raw stored `branding` block (partial / unknown / absent) with
 * defaults, returning a complete, validated cosmetic config. Malformed or
 * future-shaped blocks fall back to defaults rather than throwing — a chrome
 * read must never break because a settings blob went stale.
 */
export function resolveBrandingSettings(rawBlock: unknown): BrandingSettings {
  const parsed = brandingSettingsSchema.safeParse(rawBlock ?? {});
  return parsed.success ? parsed.data : defaultBrandingSettings();
}

// ─────────────── getTenantBranding / updateTenantBranding (AD2) ───────────────

export const getTenantBrandingInputSchema = z.object({});

/** The effective branding a tenant reads — the column + the resolved block. */
export const getTenantBrandingOutputSchema = z.object({
  displayName: z.string(),
  primaryColor: z.string(),
  logoUrl: z.string().nullable(),
  darkModeDefault: z.boolean(),
});
export type GetTenantBrandingOutput = z.infer<typeof getTenantBrandingOutputSchema>;

/**
 * The full branding the admin surface writes. `displayName` lands on the
 * COLUMN; the other three land in `settings.branding`. `logoUrl` accepts an
 * empty string from the form and coerces it to null (cleared logo).
 */
export const updateTenantBrandingInputSchema = z.object({
  displayName: z.string().trim().min(1, "Company name is required").max(MAX_DISPLAY_NAME_LEN),
  primaryColor: z.string().regex(HEX_COLOR_RE, "Enter a hex colour like #4F46E5"),
  logoUrl: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().url("Enter a valid URL").max(MAX_LOGO_URL_LEN).nullable(),
  ),
  darkModeDefault: z.boolean(),
});
export type UpdateTenantBrandingInput = z.infer<typeof updateTenantBrandingInputSchema>;

export const updateTenantBrandingOutputSchema = z.object({
  ok: z.literal(true),
  branding: getTenantBrandingOutputSchema,
});
export type UpdateTenantBrandingOutput = z.infer<typeof updateTenantBrandingOutputSchema>;
