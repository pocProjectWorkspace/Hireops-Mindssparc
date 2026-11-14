/**
 * C2-F1 — PARITY: the platform default bundles must equal the role gates the API
 * enforced before capabilities existed, for EVERY capability and EVERY role.
 *
 * `LEGACY` is a FROZEN copy of the pre-C2-F1 role sets (origin/main b19322f),
 * one row per capability, naming the constant(s) it replaces. `full` = roles
 * that passed the gate with no narrower ownership check; `own` = roles that
 * passed the coarse gate but were then limited to records they own (the old
 * `isAdmin` / `ctx.roles.includes("admin")` branches). Do NOT edit a row to make
 * this test pass — a mismatch means a member's access changed on deploy.
 */
import { describe, expect, it } from "vitest";
import {
  BASE_ROLES,
  CAPABILITIES,
  CAPABILITY_CATALOG,
  SYSTEM_ROLE_BUNDLES,
  resolveEffectivePermissions,
  systemRolesWithCapability,
  type Capability,
} from "../src/capabilities";

const INTERNAL = [
  "admin",
  "recruiter",
  "hiring_manager",
  "panel_member",
  "hr_ops",
  "people_ops",
  "it_admin",
  "hr_head",
];

interface LegacyGate {
  /** The constant(s) / check(s) this capability replaces. */
  was: string;
  full: string[];
  own?: string[];
}

// prettier-ignore
const LEGACY: Record<Capability, LegacyGate> = {
  "requisitions.read": { was: "REQUISITION_READ_ROLES", full: ["admin", "hiring_manager", "recruiter", "hr_head"] },
  "requisitions.summaries": { was: "REQUISITION_READ_ROLES + hr_ops (listRequisitionSummaries)", full: ["admin", "hiring_manager", "recruiter", "hr_head", "hr_ops"] },
  "requisitions.workspace": { was: "portal requisitions/page.tsx READ_ROLES + nav", full: ["hiring_manager", "recruiter", "admin"] },
  "requisitions.write": { was: "REQUISITION_WRITE_ROLES", full: ["admin", "hiring_manager"] },
  "requisitions.post": { was: "REQUISITION_POST_ROLES", full: ["admin", "hiring_manager", "recruiter"] },
  "requisitions.pickers": { was: "BUSINESS_UNIT_READ_ROLES / COMP_BAND_READ_ROLES / PANEL_POOL_READ_ROLES", full: ["admin", "hiring_manager", "recruiter"] },
  "requisitions.approvals_read": { was: "REQUISITION_APPROVAL_READ_ROLES", full: ["admin", "hr_head"] },
  "requisitions.approve": { was: "REQUISITION_APPROVAL_DECIDE_ROLES", full: ["admin", "hr_head"] },
  "requisitions.owner_dashboard": { was: "RO_DASHBOARD_ROLES", full: ["admin", "hiring_manager"] },
  "requisitions.owner_insights": { was: "HM_INSIGHTS_ROLES + resolveMyRequisitionScope isAdmin", full: ["admin"], own: ["hiring_manager"] },
  "requisitions.revise": { was: "RO_REVISION_ROLES + ensureReqOwnerOrAdmin", full: ["admin"], own: ["hiring_manager"] },
  "requisitions.jd_templates": { was: "JD_TEMPLATE_ROLES", full: ["admin", "hiring_manager"] },
  "candidates.triage": { was: "RECRUITER_SURFACE_ROLES", full: ["admin", "recruiter"] },
  "candidates.bulk_upload": { was: "BULK_CV_UPLOAD_ROLES", full: ["admin", "recruiter"] },
  "candidates.screening_write": { was: "SCREENING_ANSWERS_WRITE_ROLES", full: ["admin", "recruiter", "hr_ops"] },
  "candidates.comp_read": { was: "SCREENING_COMP_READ_ROLES", full: ["admin", "hr_ops", "hr_head", "recruiter"] },
  "candidates.assessment_summary": { was: "ASSESSMENT_SUMMARY_ROLES", full: ["admin", "recruiter", "hr_ops", "hr_head", "hiring_manager", "panel_member"] },
  "candidates.assessment_full": { was: "ASSESSMENT_FULL_ROLES + isRequisitionHiringManager", full: ["admin", "recruiter", "hr_ops", "hr_head"], own: ["hiring_manager"] },
  "candidates.selection_decide": { was: "SELECTION_DECISION_GATE_ROLES / SELECTION_DECISION_ROLES + isRequisitionHiringManager", full: ["admin", "recruiter"], own: ["hiring_manager"] },
  "candidates.iris_picker": { was: "IRIS_PIPELINE_PICKER_ROLES", full: ["admin", "recruiter", "hiring_manager", "hr_ops", "people_ops"] },
  "candidates.recruiter_dashboard": { was: "RECRUITER_DASHBOARD_ROLES", full: ["admin", "recruiter"] },
  "interviews.manage": { was: "INTERVIEW_MANAGE_ROLES (router + scheduling) / AVAILABILITY_VIEW_OTHERS_ROLES", full: ["admin", "hiring_manager", "recruiter"] },
  "interviews.recording_consent": { was: "RECORDING_CONSENT_MANAGE_ROLES", full: ["admin", "hiring_manager", "recruiter", "hr_ops"] },
  "interviews.notes_read": { was: "INTERVIEW_NOTES_READ_ROLES + hasManageRole", full: ["admin", "hiring_manager", "recruiter"], own: ["panel_member"] },
  "interviews.panel": { was: "PANEL_SURFACE_ROLES + isAdmin panellist checks", full: ["admin"], own: ["panel_member"] },
  "interviews.panel_pools_write": { was: "PANEL_POOL_WRITE_ROLES", full: ["admin", "recruiter"] },
  "interviews.availability_admin": { was: "AVAILABILITY_EDIT_OTHERS_ROLES", full: ["admin"] },
  "offers.comp_desk": { was: "COMP_DESK_ROLES", full: ["admin", "hr_ops"] },
  "offers.approve": { was: "OFFER_APPROVAL_DECIDE_ROLES", full: ["admin", "hr_head"] },
  "offers.comp_bands_write": { was: "COMP_BAND_WRITE_ROLES", full: ["admin", "hr_head"] },
  "offers.workday_handoff": { was: "WORKDAY_HANDOFF_ROLES", full: ["admin", "recruiter", "hr_ops"] },
  "hr_ops.cases": { was: "HR_OPS_CASE_ROLES", full: ["admin", "hr_ops"] },
  "hr_ops.documents": { was: "HR_OPS_DOC_ROLES", full: ["admin", "hr_ops"] },
  "hr_ops.resolve_recruiter_approvals": { was: "RECRUITER_RESOLVE_ROLES", full: ["admin", "recruiter", "hr_ops", "people_ops"] },
  "hr_ops.resolve_hr_approvals": { was: "HR_TEAM_RESOLVE_ROLES", full: ["admin", "hr_ops", "people_ops"] },
  "onboarding.manage": { was: "ONBOARDING_MANAGE_ROLES", full: ["admin", "recruiter", "hr_ops", "people_ops"] },
  "onboarding.offboarding": { was: "OFFBOARD_MANAGE_ROLES", full: ["admin", "hr_ops", "people_ops"] },
  "onboarding.prejoining_watchlist": { was: "JOINING_WATCHLIST_ROLES + preJoiningRecruiterScope", full: ["admin", "hr_head"], own: ["recruiter"] },
  "onboarding.prejoining_settings": { was: "PRE_JOINING_ADMIN_ROLES", full: ["admin", "hr_head"] },
  "onboarding.learning_admin": { was: "LEARNING_ADMIN_ROLES", full: ["admin", "hr_head"] },
  "reports.read": { was: "REPORTS_READ_ROLES", full: ["admin", "hr_head", "hr_ops"] },
  "reports.hr_metrics": { was: "HR_METRICS_READ_ROLES", full: ["admin", "hr_head"] },
  "reports.ask_data": { was: "ASK_DATA_ROLES + ASK_DATA_TENANT_WIDE_ROLES", full: ["admin", "hr_head", "hr_ops", "recruiter"], own: ["hiring_manager"] },
  "reports.ask_data_candidate_names": { was: "ASK_DATA_CANDIDATE_NAME_ROLES", full: ["admin", "hr_head", "hr_ops"] },
  "reports.admin": { was: "USERS_ADMIN_ROLES (getRecruitmentReport, report digests, askDataTopQuestions)", full: ["admin"] },
  "governance.manage": { was: "GOVERNANCE_READ_ROLES", full: ["admin", "hr_head"] },
  "governance.diversity_slate_view": { was: "DIVERSE_SLATE_VIEW_ROLES", full: ["admin", "hr_head", "recruiter"] },
  "governance.diversity_settings": { was: "DIVERSE_SLATE_ADMIN_ROLES", full: ["admin", "hr_head"] },
  "governance.audit_log": { was: "USERS_ADMIN_ROLES (audit + notification log)", full: ["admin"] },
  "market_intel.read": { was: "MARKET_INTEL_READ_ROLES", full: ["admin", "hr_head", "hiring_manager"] },
  "market_intel.write": { was: "MARKET_BENCHMARK_ADMIN_ROLES", full: ["admin"] },
  "market_intel.feasibility": { was: "FEASIBILITY_ROLES", full: ["admin", "hr_head"] },
  "partners.admin": { was: "PARTNER_ADMIN_ROLES", full: ["admin", "hr_ops"] },
  "organisation.pickers": { was: "ORG_ARCH_PICKER_ROLES", full: ["admin", "hr_head", "hiring_manager", "recruiter"] },
  "organisation.read": { was: "ORG_ARCH_READ_ROLES", full: ["admin", "hr_head"] },
  "organisation.write": { was: "ORG_ARCH_WRITE_ROLES / BUSINESS_UNIT_ADMIN_ROLES", full: ["admin"] },
  "settings.sla": { was: "SLA_CONFIG_ROLES", full: ["admin", "hr_head"] },
  "settings.candidate_fields": { was: "CANDIDATE_FIELD_POLICY_ROLES", full: ["admin"] },
  "settings.email_templates": { was: "EMAIL_TEMPLATE_ROLES", full: ["admin"] },
  "settings.interview_templates": { was: "INTERVIEW_TEMPLATE_ADMIN_ROLES", full: ["admin"] },
  "settings.scheduling": { was: "SCHEDULING_SETTINGS_ADMIN_ROLES", full: ["admin"] },
  "settings.sources_read": { was: "TENANT_SOURCE_READ_ROLES", full: ["admin", "recruiter"] },
  "settings.sources_write": { was: "TENANT_SOURCE_ADMIN_ROLES", full: ["admin"] },
  "settings.labels": { was: "AI_SETTINGS_ADMIN_ROLES (tenant labels) / USERS_ADMIN_ROLES (updateRoleLabels)", full: ["admin"] },
  "settings.ai": { was: "AI_SETTINGS_ADMIN_ROLES (AI settings, Iris policy, scoring weights, bias lexicon)", full: ["admin"] },
  "settings.system": { was: "USERS_ADMIN_ROLES (system setup, shortlist defaults) / AI_SETTINGS_ADMIN_ROLES (urgency)", full: ["admin"] },
  "settings.branding": { was: "USERS_ADMIN_ROLES (branding)", full: ["admin"] },
  "settings.approval_routing": { was: "USERS_ADMIN_ROLES (approval matrices)", full: ["admin"] },
  "settings.tenant_config": { was: "TENANT_CONFIG_ADMIN_ROLES", full: ["admin"] },
  "admin.console": { was: "USERS_ADMIN_ROLES (getAdminDashboardExtras) + AppShell isAdmin", full: ["admin"] },
  "admin.users": { was: "USERS_ADMIN_ROLES (users)", full: ["admin"] },
  "admin.roles": { was: "(new — role definition; admin-only like users)", full: ["admin"] },
  "admin.ai_budget": { was: "USERS_ADMIN_ROLES (AI budget/usage) + exec summary isAdmin", full: ["admin"] },
  "admin.agents": { was: "USERS_ADMIN_ROLES (agents)", full: ["admin"] },
  "admin.integrations": { was: "USERS_ADMIN_ROLES (listWorkdaySyncs)", full: ["admin"] },
  "dashboard.view": { was: "DASHBOARD_PERSONA_ROLES (= INTERNAL_TENANT_ROLES)", full: INTERNAL },
};

describe("C2-F1 parity — default bundles == pre-C2-F1 gates", () => {
  it("the legacy table covers exactly the catalog", () => {
    expect(Object.keys(LEGACY).sort()).toEqual([...CAPABILITIES].sort());
  });

  for (const cap of CAPABILITIES) {
    it(`${cap}: every role matches (${LEGACY[cap].was})`, () => {
      const legacy = LEGACY[cap];
      for (const role of BASE_ROLES) {
        const expected = legacy.full.includes(role)
          ? "all"
          : legacy.own?.includes(role)
            ? "own"
            : undefined;
        expect(SYSTEM_ROLE_BUNDLES[role][cap], `${cap} for ${role}`).toBe(expected);
      }
    });
  }

  it("non-internal roles (partner, candidate, employee) hold nothing", () => {
    for (const r of ["partner_admin", "partner_user", "candidate", "employee"] as const) {
      expect(SYSTEM_ROLE_BUNDLES[r]).toEqual({});
    }
  });

  it("it_admin holds only the home dashboard (unchanged; RL11 — no comp/candidate data)", () => {
    expect(Object.keys(SYSTEM_ROLE_BUNDLES.it_admin)).toEqual(["dashboard.view"]);
  });

  it("admin holds every capability at scope all (by bundle, not by bypass)", () => {
    for (const cap of CAPABILITIES) expect(SYSTEM_ROLE_BUNDLES.admin[cap]).toBe("all");
  });

  it("every default scope is one the capability allows", () => {
    for (const cap of CAPABILITIES) {
      for (const scope of Object.values(CAPABILITY_CATALOG[cap].defaults)) {
        expect(CAPABILITY_CATALOG[cap].scopes).toContain(scope);
      }
    }
  });

  it("multi-role union takes the widest scope (recruiter + hr_head on the watchlist = all)", () => {
    const p = resolveEffectivePermissions({ roles: ["recruiter", "hr_head"], customRole: null });
    expect(p.caps["onboarding.prejoining_watchlist"]).toBe("all");
    const r = resolveEffectivePermissions({ roles: ["recruiter"], customRole: null });
    expect(r.caps["onboarding.prejoining_watchlist"]).toBe("own");
  });

  it("systemRolesWithCapability mirrors the Iris action role lists", () => {
    expect(systemRolesWithCapability("candidates.triage")).toEqual(["admin", "recruiter"]);
    expect(systemRolesWithCapability("onboarding.manage").sort()).toEqual(
      ["admin", "hr_ops", "people_ops", "recruiter"].sort(),
    );
  });
});
