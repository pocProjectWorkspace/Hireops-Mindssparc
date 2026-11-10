/**
 * PC-14..17 — shared synthetic-tenant seed for the pre-joining tests.
 *
 * Each test file passes its own namespace (hex, 3 chars) so the fixed ids
 * never collide across files. Everything is raw poolSql with explicit
 * tenant_id; cleanup deletes only rows under the synthetic tenant.
 *
 * REQUIRES migration 0128.
 */

import { sql as poolSql } from "@hireops/db";

/** Narrow away undefined/null, failing loudly (instead of a non-null assertion). */
function must<V>(v: V | null | undefined, what = "value"): V {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

export interface SeedIds {
  T: string;
  BU: string;
  POSITION: string;
  JD: string;
  REQ: string;
  REC_A: string; // recruiter A membership (owns REQ)
  REC_B: string; // recruiter B membership (owns nothing)
  HRHEAD: string;
  PANEL: string;
  userA: string;
  userB: string;
  userH: string;
  userP: string;
}

export function seedIds(ns: string): SeedIds {
  const id = (n: string) => `00000000-0000-4000-8000-0000${ns}${n}`;
  return {
    T: id("00001"),
    BU: id("00002"),
    POSITION: id("00003"),
    JD: id("00004"),
    REQ: id("00005"),
    REC_A: id("00006"),
    REC_B: id("00007"),
    HRHEAD: id("00008"),
    PANEL: id("00009"),
    // Filled by seedTenant with borrowed auth.users ids.
    userA: "",
    userB: "",
    userH: "",
    userP: "",
  };
}

export const RUN = Date.now().toString(36);

/**
 * Memberships FK to auth.users, and tests never create auth users: borrow
 * four distinct existing ones (same convention as the other synthetic-tenant
 * tests, which borrow one).
 */
async function borrowUsers(): Promise<string[]> {
  const rows = await poolSql<
    { id: string }[]
  >`SELECT id FROM auth.users ORDER BY created_at LIMIT 4`;
  if (rows.length < 4) throw new Error("PC14 tests need at least 4 auth.users rows to borrow");
  return rows.map((r) => r.id);
}

export async function seedTenant(ids: SeedIds, ns: string, settings: unknown): Promise<void> {
  await cleanupTenant(ids);
  await poolSql`
    INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
    VALUES (${ids.T}, ${`synth-pc14-${ns}-${RUN}`}, ${`PC14 Synth ${ns}`}, 'ap-northeast-1', 'active',
            ${JSON.stringify(settings)}::jsonb)
  `;
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.BU}, ${ids.T}, ${`PC14 BU ${ns}`}, ${`pc14-bu-${ns}-${RUN}`})
  `;
  const [uA, uB, uH, uP] = await borrowUsers();
  ids.userA = must(uA);
  ids.userB = must(uB);
  ids.userH = must(uH);
  ids.userP = must(uP);
  const members: [string, string, string][] = [
    [ids.REC_A, ids.userA, "recruiter"],
    [ids.REC_B, ids.userB, "recruiter"],
    [ids.HRHEAD, ids.userH, "hr_head"],
    [ids.PANEL, ids.userP, "panel_member"],
  ];
  for (const [mid, uid, role] of members) {
    await poolSql`
      INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${mid}, ${ids.T}, ${uid}, ARRAY[${role}]::tenant_role[], 'active', ${ids.BU})
    `;
  }
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${ids.POSITION}, ${ids.T}, ${ids.BU}, 'PC14 Plant Accountant', 'hybrid', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.JD}, ${ids.T}, ${ids.POSITION}, 1, '# PC14 JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${ids.REQ}, ${ids.T}, ${ids.POSITION}, ${ids.JD}, ${ids.REC_A}, ${ids.REC_A}, 'posted')
  `;
}

/**
 * One accepted candidate: person + candidate + application at offer_accepted
 * + an accepted offer joining on `joiningDate`, accepted at `acceptedAt`.
 */
export async function seedAcceptedCandidate(
  ids: SeedIds,
  n: string,
  args: { joiningDate: string; acceptedAt: Date; email?: string },
): Promise<{ person: string; candidate: string; app: string; offer: string }> {
  const ns = ids.T.slice(-8, -5);
  const id = (k: string) => `00000000-0000-4000-8000-0000${ns}${k}${n}`;
  const person = id("b");
  const candidate = id("c");
  const app = id("d");
  const offer = id("e");
  const email = args.email ?? `pc14-${ns}-cand-${n}-${RUN}@example.test`;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${person}, ${ids.T}, ${`Priya Test ${n}`}, ${email}, ${email})
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candidate}, ${ids.T}, ${person}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${app}, ${ids.T}, ${candidate}, ${ids.REQ}, 'career_site', 'offer_accepted', now())
  `;
  await poolSql`
    INSERT INTO public.offers
      (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
       joining_date, location, expiry_at, status, accepted_at)
    VALUES (${offer}, ${ids.T}, ${app}, ${ids.REC_A}, 120000000, ${args.joiningDate}::date,
            'Pune', now() + interval '30 days', 'accepted', ${args.acceptedAt.toISOString()}::timestamptz)
  `;
  return { person, candidate, app, offer };
}

export async function cleanupTenant(ids: SeedIds): Promise<void> {
  const T = ids.T;
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.candidate_risk_signals WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.pre_joining_pulse_responses WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidate_inbound_messages WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.pre_joining_touchpoints WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.pre_joining_journeys WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.pre_joining_company_updates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.offer_reneges WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.onboarding_tasks WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.onboarding_cases WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.offers WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
    () => poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("PC14 cleanup step failed (continuing):", (err as Error).message);
    }
  }
}

export const ENABLED_IST = {
  preJoiningEngagement: {
    enabled: true,
    quietHours: { enabled: false, startHour: 20, endHour: 8, timezone: "Asia/Kolkata" },
    firstDayInfo: "Report to reception at 9:30 AM.",
  },
};
