import { AI_SETTINGS_VERSION } from "../ai-settings";
import { DIVERSITY_SLATE_SETTINGS_VERSION } from "../diversity-slate";
import { TENANT_LABELS_VERSION } from "../tenant-labels";
import { URGENCY_SETTINGS_VERSION } from "../urgency-settings";
import type { StarterPack } from "./types";

/**
 * `india-gcc-finance-gbs` — an India Global Capability Centre hiring for
 * finance / GBS (shared-services) roles. Built from what the first India GCC
 * pilot needed, generalised: no client names, placeholders where a client's
 * own value is expected (the legal entity name).
 *
 * Shaped for India GBS hiring realities:
 *   - IST everywhere (scheduling, pre-joining quiet hours, locations);
 *   - 60–90-day notice periods are normal, so the urgency notice bands run
 *     30/60/90/120/180 days — a 90-day candidate reads "medium", not "low";
 *   - finance / process functions (P2P, O2C, R2R, SAP, …) and IN09–IN18 grades;
 *   - one competency scorecard (People, Performance, Results, Functional,
 *     Competencies) over a four-round loop;
 *   - India statutory onboarding documents: UAN as a tenant type on top of
 *     the platform's PAN / Aadhaar / PF (auto-collected) and ESIC (requestable).
 */

const IN_ENTITY = "India legal entity";

const city = (name: string, region: string) => ({
  name,
  city: name === "Delhi NCR" ? "New Delhi" : name,
  region,
  countryCode: "IN",
  legalEntity: IN_ENTITY,
  timezone: "Asia/Kolkata",
  isActive: true,
});

const fn = (key: string, label: string, sortOrder: number) => ({
  key,
  label,
  sortOrder,
  isActive: true,
});

export const INDIA_GCC_FINANCE_GBS_STARTER_PACK: StarterPack = {
  key: "india-gcc-finance-gbs",
  // v2 (C2-F12): + interview loop registry and default applicability rules.
  version: 2,
  label: "India GCC — finance / GBS",
  description:
    "India capability centre hiring finance and shared-services roles: IST, INR, six metro locations, P2P / O2C / R2R / SAP functions, IN09–IN18 grades, a four-round competency loop, India statutory documents and urgency tuned for 60–90-day notice.",
  modules: {
    ai_interview: true,
    notetaker: true,
    market_intel: true,
    partner_portal: true,
    onboarding: true,
    learning: false,
    bulk_cv_upload: true,
    scheduling: true,
    pre_joining_engagement: true,
    welcome_guide: true,
    diversity_slate: false,
    ask_data: true,
    report_insights: true,
    workday_handoff: true,
  },
  defaultRegion: "ap-south-1",
  config: {
    // defaultCountry places a bare 10-digit mobile number in India for person
    // dedup (C1-BUGS BUG-5 — there is no platform default country).
    locale: {
      currency: "INR",
      timezone: "Asia/Kolkata",
      locale: "en-IN",
      defaultCountry: "IN",
    },
    settings: {
      labels: {
        version: TENANT_LABELS_VERSION,
        stages: {
          ai_screening: { staff: "Screening" },
          shortlisted: { staff: "Manager review", candidate: "Under review" },
          tech_interview: { staff: "Interview", candidate: "Interview", partner: "Interview" },
          hr_round: { staff: "HR discussion", candidate: "HR discussion" },
          offer_drafted: { staff: "Offer release" },
          offer_accepted: { staff: "Ready for hire" },
        },
        recommendations: {
          strong_yes: "Strong hire",
          yes: "Hire",
          hold: "Hold",
          no: "Do not hire",
        },
      },
      // Working-day-ish SLAs: GBS panels are business stakeholders, not
      // full-time interviewers.
      slaThresholds: {
        application_received: 48,
        ai_screening: 4,
        recruiter_review: 72,
        shortlisted: 72,
        tech_interview: 120,
        hr_round: 72,
        offer_drafted: 72,
      },
      scheduling: {
        timezone: "Asia/Kolkata",
        durationPresets: [30, 45, 60],
        defaultDurationMinutes: 45,
        workingHoursStart: "09:30",
        workingHoursEnd: "18:30",
        workingDays: [1, 2, 3, 4, 5],
      },
      preJoiningEngagement: {
        enabled: false,
        cadenceDays: 14,
        quietHours: { enabled: true, startHour: 20, endHour: 8, timezone: "Asia/Kolkata" },
      },
      diversitySlate: { version: DIVERSITY_SLATE_SETTINGS_VERSION, enabled: false },
      aiSettings: {
        version: AI_SETTINGS_VERSION,
        piiMasking: true,
        screeningScoreVisible: true,
        screeningScoreBands: { strong: 85, good: 70, partial: 55 },
      },
      urgency: {
        version: URGENCY_SETTINGS_VERSION,
        weights: { sla: 40, daysInStage: 35, notice: 25 },
        noticeBands: [30, 60, 90, 120, 180],
      },
    },
    lookups: [
      {
        kind: "offer_decline_reason",
        key: "competing_gcc_offer",
        label: "Accepted another GCC offer",
        sortOrder: 25,
        isActive: true,
        attrs: {},
      },
      {
        kind: "offer_decline_reason",
        key: "notice_buyout",
        label: "Notice period buy-out not possible",
        sortOrder: 65,
        isActive: true,
        attrs: {},
      },
    ],
    legalEntities: [{ name: IN_ENTITY, countryCode: "IN", isActive: true }],
    locations: [
      city("Hyderabad", "Telangana"),
      city("Bengaluru", "Karnataka"),
      city("Pune", "Maharashtra"),
      city("Mumbai", "Maharashtra"),
      city("Chennai", "Tamil Nadu"),
      city("Delhi NCR", "Delhi NCR"),
    ],
    jobFunctions: [
      fn("finance", "Finance", 10),
      fn("procure_to_pay", "Procure to Pay", 20),
      fn("order_to_cash", "Order to Cash", 30),
      fn("record_to_report", "Record to Report", 40),
      fn("sap", "SAP", 50),
      fn("it_non_sap", "IT Non SAP", 60),
      fn("hr", "HR", 70),
      fn("supply_chain", "Supply Chain", 80),
      fn("sales", "Sales", 90),
      fn("transformation", "Transformation", 100),
    ],
    jobLevels: Array.from({ length: 10 }, (_, i) => {
      const n = i + 9;
      const key = `IN${String(n).padStart(2, "0")}`;
      return { key, label: key, rank: n, isActive: true };
    }),
    scorecardTemplates: [
      {
        scorecardKey: "gcc_competencies",
        label: "GCC competencies",
        criteria: [
          { key: "people", label: "People" },
          { key: "performance", label: "Performance" },
          { key: "results", label: "Results" },
          { key: "functional", label: "Functional" },
          { key: "competencies", label: "Competencies" },
        ],
      },
    ],
    // C2-F12: the four rounds below are the 'default' loop; the default
    // assignments make the loop + scorecard choice explicit (no conditions =
    // applies to every requisition), so a tenant adds band / function
    // specific loops beside them instead of editing the default.
    interviewLoops: [{ loopKey: "default", label: "Default loop", isActive: true }],
    templateAssignments: [
      {
        templateKind: "interview_loop",
        name: "Default interview loop",
        template: "default",
        priority: 0,
        isActive: true,
        conditions: {},
      },
      {
        templateKind: "scorecard",
        name: "Default scorecard",
        template: "gcc_competencies",
        priority: 0,
        isActive: true,
        conditions: {},
      },
    ],
    interviewRounds: [
      {
        roundNumber: 1,
        roundName: "Recruiter screen",
        durationMinutes: 30,
        mode: "phone",
        scorecardTemplateKey: "gcc_competencies",
        competencyFocus: ["Notice period", "Expected CTC", "Location"],
      },
      {
        roundNumber: 2,
        roundName: "Functional interview",
        durationMinutes: 60,
        mode: "video",
        scorecardTemplateKey: "gcc_competencies",
        competencyFocus: ["Functional", "Results"],
      },
      {
        roundNumber: 3,
        roundName: "Hiring manager interview",
        durationMinutes: 45,
        mode: "video",
        scorecardTemplateKey: "gcc_competencies",
        competencyFocus: ["People", "Performance"],
      },
      {
        roundNumber: 4,
        roundName: "HR discussion",
        durationMinutes: 30,
        mode: "video",
        scorecardTemplateKey: "gcc_competencies",
        competencyFocus: ["Competencies"],
      },
    ],
    // India statutory documents. The platform catalogue (tenant_id NULL)
    // already auto-collects PAN (`pan_card`), Aadhaar (`aadhaar`) and the PF
    // declaration (`form_11_pf`) at pre-boarding for IN cases, and offers ESIC
    // (`esic`) as requestable-only because it applies below the statutory wage
    // ceiling. The pack therefore adds only what the platform lacks — a tenant
    // row with a platform code would REPLACE that platform type for the tenant
    // (C1-BUGS BUG-4), freezing it against later platform corrections.
    documentTypes: [
      {
        code: "uan",
        name: "UAN (Universal Account Number)",
        geographyCode: "IN",
        requiredForLifecycleStage: "pre_boarding",
        retentionYears: 8,
      },
    ],
  },
};
