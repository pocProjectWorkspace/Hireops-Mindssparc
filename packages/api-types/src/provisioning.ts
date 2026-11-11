import { z } from "zod";
import { platformModuleKeySchema } from "./platform";

/**
 * C1-F11 — tenant provisioning (Plan A §14.3 steps 1–2) and the basic tenant
 * setup wizard (§14.3 steps 3–4).
 *
 * Provisioning is an idempotent, resumable job over a fixed list of steps,
 * recorded in `tenant_provisioning_jobs` (platform table). Every step can be
 * re-run without duplicating anything; a failed run is resumed with
 * platformRetryProvisioning and picks up at the first step not yet done.
 */

const pgUuid = z.guid();

// ─────────────────────────── provisioning ───────────────────────────

export const PROVISIONING_STEPS = [
  "tenant_row",
  "encryption_key",
  "modules",
  "starter_pack",
  "admin_invite",
  "admin_membership",
  "activate",
] as const;
export type ProvisioningStepKey = (typeof PROVISIONING_STEPS)[number];

export const PROVISIONING_STEP_LABELS: Record<ProvisioningStepKey, string> = {
  tenant_row: "Tenant record",
  encryption_key: "Tenant encryption key",
  modules: "Module entitlements",
  starter_pack: "Starter pack configuration",
  admin_invite: "Invite first tenant admin",
  admin_membership: "Admin membership",
  activate: "Activate tenant",
};

export const PROVISIONING_JOB_STATUSES = ["pending", "running", "failed", "completed"] as const;
export type ProvisioningJobStatus = (typeof PROVISIONING_JOB_STATUSES)[number];

export const TENANT_TIERS = ["standard", "sandbox", "dedicated"] as const;
export const tenantTierSchema = z.enum(TENANT_TIERS);
export type TenantTier = z.infer<typeof tenantTierSchema>;

/** Same rule as the tenants_slug_format_check constraint. */
export const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+$/, "Use lower-case letters, digits and hyphens")
  .min(3)
  .max(40);

export const platformCreateTenantInputSchema = z.object({
  slug: tenantSlugSchema,
  displayName: z.string().trim().min(2).max(80),
  /** Data region note (tenants.primary_region), e.g. ap-south-1. */
  primaryRegion: z
    .string()
    .trim()
    .regex(/^[a-z]{2}-[a-z]+-\d$/, "Use a region code like ap-south-1"),
  tier: tenantTierSchema.default("standard"),
  starterPack: z.string().trim().min(1).max(63),
  /** Per-module overrides on top of the pack's recommendation. */
  modules: z
    .array(z.object({ key: platformModuleKeySchema, enabled: z.boolean() }))
    .max(40)
    .default([]),
  adminEmail: z.string().trim().toLowerCase().email().max(320),
  adminDisplayName: z.string().trim().min(1).max(120).optional(),
});
export type PlatformCreateTenantInput = z.input<typeof platformCreateTenantInputSchema>;

export const provisioningStepViewSchema = z.object({
  key: z.enum(PROVISIONING_STEPS),
  label: z.string(),
  status: z.enum(["pending", "done", "failed"]),
  completedAt: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type ProvisioningStepView = z.infer<typeof provisioningStepViewSchema>;

export const provisioningStatusSchema = z.object({
  tenantId: pgUuid,
  slug: z.string(),
  displayName: z.string(),
  tenantStatus: z.string(),
  jobStatus: z.enum(PROVISIONING_JOB_STATUSES),
  starterPack: z.object({ key: z.string(), version: z.number().int() }),
  adminEmail: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  steps: z.array(provisioningStepViewSchema),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ProvisioningStatus = z.infer<typeof provisioningStatusSchema>;

export const platformCreateTenantOutputSchema = provisioningStatusSchema;
export const platformGetProvisioningStatusInputSchema = z.object({ tenantId: pgUuid });
export const platformGetProvisioningStatusOutputSchema = z.object({
  /** null → the tenant predates provisioning (made by a seed script). */
  status: provisioningStatusSchema.nullable(),
});
export const platformRetryProvisioningInputSchema = z.object({ tenantId: pgUuid });
export const platformRetryProvisioningOutputSchema = provisioningStatusSchema;

export const starterPackSummarySchema = z.object({
  key: z.string(),
  version: z.number().int(),
  label: z.string(),
  description: z.string(),
  defaultRegion: z.string(),
  modules: z.record(z.string(), z.boolean()),
  /** Section → record count, for the create form. */
  contents: z.record(z.string(), z.number().int()),
});
export type StarterPackSummary = z.infer<typeof starterPackSummarySchema>;
export const platformListStarterPacksOutputSchema = z.object({
  packs: z.array(starterPackSummarySchema),
});

export const platformExportTenantConfigInputSchema = z.object({ tenantId: pgUuid });

/** settings.starterPack — what was applied at provisioning. */
export const starterPackMarkerSchema = z.object({
  key: z.string(),
  version: z.number().int(),
  appliedAt: z.string(),
});
export type StarterPackMarker = z.infer<typeof starterPackMarkerSchema>;

// ─────────────────────────── setup wizard ───────────────────────────

export const TENANT_SETUP_STEPS = [
  "organisation",
  "roles_users",
  "job_architecture",
  "hiring_process",
  "communications",
  "go_live",
] as const;
export type TenantSetupStepKey = (typeof TENANT_SETUP_STEPS)[number];
export const tenantSetupStepKeySchema = z.enum(TENANT_SETUP_STEPS);

export interface TenantSetupStepDef {
  key: TenantSetupStepKey;
  label: string;
  description: string;
  /** The existing admin pages that do the work — the wizard links, never re-implements. */
  links: { label: string; href: string }[];
}

export const TENANT_SETUP_STEP_DEFS: readonly TenantSetupStepDef[] = [
  {
    key: "organisation",
    label: "Organisation & locale",
    description:
      "Company name, legal entities, locations and business units. At least one business unit is needed before go-live.",
    links: [
      { label: "Branding (company name)", href: "/admin/branding" },
      { label: "Organisation (entities, locations)", href: "/admin/organisation" },
      { label: "Business units", href: "/admin/business-units" },
    ],
  },
  {
    key: "roles_users",
    label: "Roles & users",
    description:
      "Invite recruiters, hiring managers, HR and other admins, and give each their roles.",
    links: [
      { label: "Users", href: "/admin/users" },
      { label: "Role labels", href: "/admin/labels" },
    ],
  },
  {
    key: "job_architecture",
    label: "Job architecture",
    description:
      "Review the functions, levels and job profiles from the starter pack; add comp bands.",
    links: [
      { label: "Job architecture", href: "/admin/job-architecture" },
      { label: "Comp bands", href: "/admin/comp-bands" },
      { label: "Lists", href: "/admin/lists" },
    ],
  },
  {
    key: "hiring_process",
    label: "Hiring process",
    description:
      "Interview rounds and scorecards, stage wording, SLAs and approval routing (or skip approvals explicitly).",
    links: [
      { label: "Interview templates", href: "/admin/interview-templates" },
      { label: "Labels", href: "/admin/labels" },
      { label: "SLA thresholds", href: "/admin/sla-thresholds" },
      { label: "Approval routing", href: "/admin/approval-routing" },
    ],
  },
  {
    key: "communications",
    label: "Communications & branding",
    description:
      "The sender name candidates see on email, the logo and brand colour, and any email copy changes.",
    links: [
      { label: "Branding (logo, colour)", href: "/admin/branding" },
      { label: "Email templates", href: "/admin/email-templates" },
    ],
  },
  {
    key: "go_live",
    label: "Go-live checklist",
    description: "Everything required is in place. Marks setup complete for this organisation.",
    links: [],
  },
];

export const TENANT_SETUP_CHECKS = [
  "admin_present",
  "business_unit_present",
  "approval_routing",
  "sender_name",
] as const;
export type TenantSetupCheckKey = (typeof TENANT_SETUP_CHECKS)[number];

export const tenantSetupCheckSchema = z.object({
  key: z.enum(TENANT_SETUP_CHECKS),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type TenantSetupCheck = z.infer<typeof tenantSetupCheckSchema>;

/** settings.setup — the wizard's own state (never exported). */
export const tenantSetupStateSchema = z.object({
  completedSteps: z.array(tenantSetupStepKeySchema).default([]),
  approvalRoutingSkipped: z.boolean().default(false),
  completedAt: z.string().nullable().default(null),
});
export type TenantSetupState = z.infer<typeof tenantSetupStateSchema>;

export function resolveTenantSetupState(raw: unknown): TenantSetupState {
  const p = tenantSetupStateSchema.safeParse(raw ?? {});
  return p.success
    ? { ...p.data, completedSteps: [...new Set(p.data.completedSteps)] }
    : { completedSteps: [], approvalRoutingSkipped: false, completedAt: null };
}

export const getTenantSetupInputSchema = z.object({}).default({});
export const getTenantSetupOutputSchema = z.object({
  onboardingStatus: z.string(),
  starterPack: starterPackMarkerSchema.nullable(),
  steps: z.array(
    z.object({
      key: tenantSetupStepKeySchema,
      label: z.string(),
      description: z.string(),
      links: z.array(z.object({ label: z.string(), href: z.string() })),
      complete: z.boolean(),
    }),
  ),
  checks: z.array(tenantSetupCheckSchema),
  canGoLive: z.boolean(),
  approvalRoutingSkipped: z.boolean(),
  senderName: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type GetTenantSetupOutput = z.infer<typeof getTenantSetupOutputSchema>;

export const setTenantSetupStepInputSchema = z.object({
  step: tenantSetupStepKeySchema.exclude(["go_live"]),
  complete: z.boolean(),
});
export const setTenantSetupApprovalSkipInputSchema = z.object({ skipped: z.boolean() });
export const updateTenantSenderNameInputSchema = z.object({
  senderName: z.string().trim().min(1).max(80).nullable(),
});
export const tenantSetupMutationOutputSchema = getTenantSetupOutputSchema;
export const tenantGoLiveInputSchema = z.object({}).default({});
