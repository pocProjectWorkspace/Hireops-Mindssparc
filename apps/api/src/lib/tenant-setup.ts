/**
 * C1-F11 — the basic tenant setup wizard (Plan A §14.3 steps 3–4).
 *
 * Uses the long-unused tenants.onboarding_status / onboarding_step_completed
 * columns: onboarding_status stays `in_progress` until go-live flips it to
 * `completed`; onboarding_step_completed mirrors the furthest step ticked.
 * The per-step ticks + the explicit "skip approval routing" decision live in
 * tenants.settings.setup (never exported). Each step LINKS to the existing
 * admin pages; nothing here re-implements them.
 *
 * Go-live (required): ≥1 active admin, ≥1 active business unit, approval
 * routing configured OR explicitly skipped, a sender display name. Going live
 * completes ONBOARDING only — the lifecycle status stays operator-controlled
 * (an operator activates a tenant; a tenant admin cannot).
 *
 * Service-role reads with an explicit tenant predicate (tenants has no
 * authenticated UPDATE policy, so the writes must be service-role anyway).
 */

import type { sql as poolSql } from "@hireops/db";
import {
  TENANT_SETUP_STEPS,
  TENANT_SETUP_STEP_DEFS,
  resolveCommunicationsSettings,
  resolveTenantSetupState,
  starterPackMarkerSchema,
  type GetTenantSetupOutput,
  type TenantSetupCheck,
  type TenantSetupState,
  type TenantSetupStepKey,
} from "@hireops/api-types";

type SqlHandle = typeof poolSql;
type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function loadTenant(sql: SqlHandle, tenantId: string) {
  const [t] = await sql<{ onboarding_status: string; settings: Json | null }[]>`
    SELECT onboarding_status, settings FROM public.tenants WHERE id = ${tenantId}
  `;
  if (!t) throw new Error("tenant_not_found");
  return {
    onboardingStatus: t.onboarding_status,
    settings: isRecord(t.settings) ? t.settings : {},
  };
}

export async function computeSetupChecks(
  sql: SqlHandle,
  tenantId: string,
  state: TenantSetupState,
  senderName: string | null,
): Promise<TenantSetupCheck[]> {
  const [c] = await sql<{ admins: number; bus: number; matrices: number }[]>`
    SELECT
      (SELECT count(*)::int FROM public.tenant_user_memberships
        WHERE tenant_id = ${tenantId} AND status = 'active' AND 'admin' = ANY(roles)) AS admins,
      (SELECT count(*)::int FROM public.business_units
        WHERE tenant_id = ${tenantId} AND is_archived = false) AS bus,
      (SELECT count(*)::int FROM public.approval_matrices
        WHERE tenant_id = ${tenantId} AND effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())) AS matrices
  `;
  const admins = c?.admins ?? 0;
  const bus = c?.bus ?? 0;
  const matrices = c?.matrices ?? 0;
  return [
    {
      key: "admin_present",
      label: "At least one admin",
      ok: admins >= 1,
      detail: `${admins} active admin${admins === 1 ? "" : "s"}`,
    },
    {
      key: "business_unit_present",
      label: "At least one business unit",
      ok: bus >= 1,
      detail:
        bus >= 1 ? `${bus} business unit${bus === 1 ? "" : "s"}` : "Add one under Business units",
    },
    {
      key: "approval_routing",
      label: "Approval routing configured or explicitly skipped",
      ok: matrices >= 1 || state.approvalRoutingSkipped,
      detail:
        matrices >= 1
          ? `${matrices} approval polic${matrices === 1 ? "y" : "ies"} in force`
          : state.approvalRoutingSkipped
            ? "Skipped — approvals fall back to the HR head"
            : "Configure Approval routing, or skip it explicitly",
    },
    {
      key: "sender_name",
      label: "Email sender name set",
      ok: Boolean(senderName),
      detail: senderName ? `Emails come from "${senderName}"` : "Set the sender name below",
    },
  ];
}

export async function getTenantSetup(
  sql: SqlHandle,
  tenantId: string,
): Promise<GetTenantSetupOutput> {
  const t = await loadTenant(sql, tenantId);
  const state = resolveTenantSetupState(t.settings.setup);
  const senderName = resolveCommunicationsSettings(t.settings.communications).senderName;
  const checks = await computeSetupChecks(sql, tenantId, state, senderName);
  const marker = starterPackMarkerSchema.safeParse(t.settings.starterPack);
  const done = new Set<TenantSetupStepKey>(state.completedSteps);
  if (t.onboardingStatus === "completed") done.add("go_live");
  return {
    onboardingStatus: t.onboardingStatus,
    starterPack: marker.success ? marker.data : null,
    steps: TENANT_SETUP_STEP_DEFS.map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      links: s.links,
      complete: done.has(s.key),
    })),
    checks,
    canGoLive: checks.every((c) => c.ok),
    approvalRoutingSkipped: state.approvalRoutingSkipped,
    senderName,
    completedAt: state.completedAt,
  };
}

async function writeSetupState(
  sql: SqlHandle,
  tenantId: string,
  state: TenantSetupState,
  extra: { onboardingStatus?: "completed" } = {},
): Promise<void> {
  const furthest =
    [...TENANT_SETUP_STEPS].reverse().find((s) => state.completedSteps.includes(s)) ?? null;
  await sql`
    UPDATE public.tenants
       SET settings = COALESCE(settings, '{}'::jsonb)
                      || jsonb_build_object('setup', ${JSON.stringify(state)}::jsonb),
           onboarding_step_completed = ${furthest},
           onboarding_status = COALESCE(${extra.onboardingStatus ?? null}, onboarding_status)
     WHERE id = ${tenantId}
  `;
}

export async function setTenantSetupStep(
  sql: SqlHandle,
  tenantId: string,
  step: TenantSetupStepKey,
  complete: boolean,
): Promise<void> {
  const t = await loadTenant(sql, tenantId);
  const state = resolveTenantSetupState(t.settings.setup);
  const set = new Set(state.completedSteps);
  if (complete) set.add(step);
  else set.delete(step);
  await writeSetupState(sql, tenantId, {
    ...state,
    completedSteps: TENANT_SETUP_STEPS.filter((s) => set.has(s)),
  });
}

export async function setApprovalRoutingSkipped(
  sql: SqlHandle,
  tenantId: string,
  skipped: boolean,
): Promise<void> {
  const t = await loadTenant(sql, tenantId);
  const state = resolveTenantSetupState(t.settings.setup);
  await writeSetupState(sql, tenantId, { ...state, approvalRoutingSkipped: skipped });
}

export async function setTenantSenderName(
  sql: SqlHandle,
  tenantId: string,
  senderName: string | null,
): Promise<void> {
  await sql`
    UPDATE public.tenants
       SET settings = COALESCE(settings, '{}'::jsonb)
                      || jsonb_build_object('communications',
                           COALESCE(settings->'communications', '{}'::jsonb)
                           || jsonb_build_object('senderName', ${senderName}::text))
     WHERE id = ${tenantId}
  `;
}

export type GoLiveResult = { ok: true } | { ok: false; failing: TenantSetupCheck[] };

/** Flip onboarding to completed when every required check passes. */
export async function goLive(sql: SqlHandle, tenantId: string): Promise<GoLiveResult> {
  const t = await loadTenant(sql, tenantId);
  const state = resolveTenantSetupState(t.settings.setup);
  const senderName = resolveCommunicationsSettings(t.settings.communications).senderName;
  const checks = await computeSetupChecks(sql, tenantId, state, senderName);
  const failing = checks.filter((c) => !c.ok);
  if (failing.length > 0) return { ok: false, failing };
  const completedSteps = TENANT_SETUP_STEPS.filter(
    (s) => s === "go_live" || state.completedSteps.includes(s),
  );
  await writeSetupState(
    sql,
    tenantId,
    { ...state, completedSteps, completedAt: state.completedAt ?? new Date().toISOString() },
    { onboardingStatus: "completed" },
  );
  return { ok: true };
}
