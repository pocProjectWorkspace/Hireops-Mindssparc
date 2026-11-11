import { z } from "zod";

/**
 * CFG-LITE / Plan A PP1 — tenant-configurable recruiter-urgency policy.
 *
 * Persisted to `tenants.settings.urgency` (a SIBLING key — no migration). The
 * recruiter-urgency engine (apps/api/src/lib/recruiter-urgency.ts) is a pure
 * function; this block only supplies its two policy inputs:
 *
 *   - `weights`     — the max points each component can earn (SLA state, time
 *                     in stage, notice period). Must sum to 100 so the index
 *                     stays a 0–100 scale.
 *   - `noticeBands` — five ascending day ceilings. A notice period at or under
 *                     band 1 earns the full notice weight, band 2 80 %, band 3
 *                     60 %, band 4 32 %, band 5 16 %, longer earns nothing.
 *
 * Platform default = today's hard-coded values (weights 40 / 35 / 25, bands
 * 0 / 15 / 30 / 60 / 90 days), so an unconfigured tenant is byte-identical.
 * A market where 90-day notice is the norm sets e.g. [0, 30, 60, 90, 120] so a
 * 90-day candidate reads as an ordinary runway, not "low urgency".
 *
 * Resolver never throws; each field falls back on its own when malformed.
 */

export const URGENCY_SETTINGS_VERSION = 1 as const;

export const URGENCY_WEIGHTS_DEFAULT = { sla: 40, daysInStage: 35, notice: 25 } as const;
export const URGENCY_NOTICE_BANDS_DEFAULT = [0, 15, 30, 60, 90] as const;
/** Share of the notice weight earned in each band (fixed; only the day ceilings are tenant policy). */
export const URGENCY_NOTICE_BAND_SHARES = [1, 0.8, 0.6, 0.32, 0.16] as const;
export const URGENCY_NOTICE_MAX_DAYS = 365;

export const urgencyWeightsSchema = z
  .object({
    sla: z.number().int().min(0).max(100),
    daysInStage: z.number().int().min(0).max(100),
    notice: z.number().int().min(0).max(100),
  })
  .refine((w) => w.sla + w.daysInStage + w.notice === 100, {
    message: "Urgency weights must add up to 100.",
  });
export type UrgencyWeights = z.infer<typeof urgencyWeightsSchema>;

export const urgencyNoticeBandsSchema = z
  .array(z.number().int().min(0).max(URGENCY_NOTICE_MAX_DAYS))
  .length(5)
  .refine((b) => b.every((d, i) => i === 0 || d > (b[i - 1] as number)), {
    message: "Notice bands must be strictly ascending.",
  });

/** The WRITE payload: both fields required and validated strictly. */
export const urgencySettingsSchema = z.object({
  version: z.literal(URGENCY_SETTINGS_VERSION).default(URGENCY_SETTINGS_VERSION),
  weights: urgencyWeightsSchema,
  noticeBands: urgencyNoticeBandsSchema,
});

export interface UrgencySettings {
  version: typeof URGENCY_SETTINGS_VERSION;
  weights: UrgencyWeights;
  noticeBands: number[];
}

export function defaultUrgencySettings(): UrgencySettings {
  return {
    version: URGENCY_SETTINGS_VERSION,
    weights: { ...URGENCY_WEIGHTS_DEFAULT },
    noticeBands: [...URGENCY_NOTICE_BANDS_DEFAULT],
  };
}

/**
 * Merge a raw stored `urgency` block over the platform default. Each field is
 * validated on its own: a bad `weights` keeps a good `noticeBands` and vice
 * versa. Absent / garbage → defaults. Never throws.
 */
export function resolveUrgencySettings(raw: unknown): UrgencySettings {
  const out = defaultUrgencySettings();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const w = urgencyWeightsSchema.safeParse(r.weights);
  if (w.success) out.weights = w.data;
  const b = urgencyNoticeBandsSchema.safeParse(r.noticeBands);
  if (b.success) out.noticeBands = b.data;
  return out;
}

const urgencySettingsWireSchema = z.object({
  version: z.literal(URGENCY_SETTINGS_VERSION),
  weights: z.object({ sla: z.number(), daysInStage: z.number(), notice: z.number() }),
  noticeBands: z.array(z.number()),
});

export const getUrgencySettingsInputSchema = z.object({});
export const getUrgencySettingsOutputSchema = urgencySettingsWireSchema;
export type GetUrgencySettingsOutput = z.infer<typeof getUrgencySettingsOutputSchema>;

export const updateUrgencySettingsInputSchema = urgencySettingsSchema;
export type UpdateUrgencySettingsInput = z.input<typeof updateUrgencySettingsInputSchema>;
export const updateUrgencySettingsOutputSchema = z.object({
  ok: z.literal(true),
  urgency: urgencySettingsWireSchema,
});
export type UpdateUrgencySettingsOutput = z.infer<typeof updateUrgencySettingsOutputSchema>;
