/**
 * @hireops/api-types
 *
 * Zod schemas + TypeScript types for the tRPC API surface, shared with
 * the frontend so apps/internal-portal and friends don't reach into
 * apps/api. The AppRouter *type* lives in apps/api and is consumed via
 * `import type { AppRouter } from '@hireops/api/trpc'` (type-only,
 * erased at bundle time).
 */

export * from "./enums";
export * from "./procedures";
export * from "./admin-ops";
export * from "./jd-quality";
export * from "./ai-settings";
export * from "./bias-lexicon";
export * from "./scoring-weights";
export * from "./governance";
export * from "./market-intelligence";
export * from "./comp";
export * from "./panel-prep";
export * from "./req-revision";
export * from "./requirement-owner";
export * from "./recruiter";
export * from "./recruiter-brief";
export * from "./admin-dashboard";
export * from "./branding";
export * from "./tenant-sources";
export * from "./candidate-field-policy";
export * from "./screening-answers";
export * from "./candidate-list";
export * from "./diversity-slate";
export * from "./interview-templates";
export * from "./admin-approval-routing";
export * from "./email-template-overrides";
export * from "./business-units";
export * from "./comp-bands";
export * from "./panel-pools";
export * from "./sla-thresholds";
export * from "./retention-policy";
export * from "./partner-defaults";
export * from "./iris";
export * from "./learning";
export * from "./reports";
export * from "./ask-data";
export * from "./interview-transcripts";
export * from "./ai-interview";
export * from "./ai-interview-answers";
export * from "./assessment-summary";
export * from "./workday-import";
export * from "./bulk-cv-upload";
export * from "./screening-evidence";
export * from "./workday-handoff";
export * from "./scheduling-slots";
export * from "./scheduling";
export * from "./pre-joining-engagement";
// Both ./scheduling-slots (PC-8: (tz, epochMs) → weekday/minutes) and
// ./pre-joining-engagement (PC-14: (Date, tz) → { date, hour }) export a
// `localParts`. The barrel's `localParts` is the pre-joining one (its callers
// import it from "@hireops/api-types"); the slot engine's is used only inside
// ./scheduling-slots and its test, which import it by path.
export { localParts } from "./pre-joining-engagement";
export * from "./welcome-guide";
export * from "./role-labels";
export * from "./tenant-labels";
export * from "./urgency-settings";
export * from "./phone";
export * from "./offer-expiry";
export * from "./platform";
// C1-F3 — organisation + job architecture + tenant lookups
export * from "./tenant-lookups";
export * from "./org-architecture";
// C1-F11 — provisioning, starter packs, setup wizard, config export/import
export * from "./tenant-config";
export * from "./provisioning";
export * from "./starter-packs";
export * from "./capabilities";
