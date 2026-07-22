export * from "./render";
export * from "./catalog";
export { type SlotOverrides } from "./slots";
export {
  ApplicationReceived,
  type ApplicationReceivedProps,
} from "./templates/application-received";
export { StageAdvanced, type StageAdvancedProps } from "./templates/stage-advanced";
export { SlaBreachImminent, type SlaBreachImminentProps } from "./templates/sla-breach-imminent";
export { SlaOpsAlert, type SlaOpsAlertProps, type SlaOpsSeverity } from "./templates/sla-ops-alert";
export { OfferExtended, type OfferExtendedProps } from "./templates/offer-extended";
export {
  InterviewInvitation,
  type InterviewInvitationProps,
} from "./templates/interview-invitation";
export { InterviewCancelled, type InterviewCancelledProps } from "./templates/interview-cancelled";
export {
  CandidateAccountActivation,
  type CandidateAccountActivationProps,
} from "./templates/candidate-account-activation";
export {
  OfferAcceptedRecruiter,
  type OfferAcceptedRecruiterProps,
} from "./templates/offer-accepted-recruiter";
export {
  OfferDeclinedRecruiter,
  type OfferDeclinedRecruiterProps,
} from "./templates/offer-declined-recruiter";
