/** @jsxRuntime automatic @jsxImportSource react */
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { resolveSlot, type SlotOverrides } from "../slots";

export interface PartnerStageChangedProps {
  /** The submitting partner user, as partner_users.full_name has them. */
  partnerContactName: string;
  /** The candidate whose application moved. */
  candidateName: string;
  /** The requisition the application belongs to (position title). */
  requisitionTitle: string;
  /** The hiring organisation — the tenant's display name (e.g. "Kyndryl"). */
  companyName: string;
  /** Human label for the new stage, e.g. "Technical interview". */
  stageLabel: string;
  /** Human-readable transition date, e.g. "13 August 2026". */
  changedAtFormatted: string;
  /**
   * True for the stages that END the candidate's run (offer declined,
   * withdrawn, not moving forward). Switches the copy to the neutral
   * "no longer progressing" phrasing — the stage label is stated, the REASON
   * never is.
   */
  isTerminal: boolean;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * P0.4 — the partner's stage-change notice for a candidate they submitted.
 *
 * Sent from transitionApplicationStage for the PARTNER_VISIBLE_STAGES only, to
 * the partner user recorded on applications.submitted_by_partner_user_id.
 *
 * PRIVACY (requirements.md §6.3), and the reason this template's prop list is
 * deliberately this short: stage + date + candidate name ONLY. Never the
 * rejection reason, never interview feedback or scores, never an interviewer's
 * name, never that another partner exists. `isTerminal` exists so a rejection
 * can be delivered honestly ("no longer progressing" + the stage label) without
 * ever explaining WHY — the explanation is internal, and a partner-facing
 * template that could carry one would be a leak waiting to happen.
 */
export function PartnerStageChanged({
  partnerContactName,
  candidateName,
  requisitionTitle,
  companyName,
  stageLabel,
  changedAtFormatted,
  isTerminal,
  slots,
}: PartnerStageChangedProps) {
  const tok = {
    partnerContactName,
    candidateName,
    requisitionTitle,
    companyName,
    stageLabel,
    changedAtFormatted,
  };
  return (
    <Html>
      <Head />
      <Preview>{`${candidateName} — ${stageLabel}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {isTerminal
              ? resolveSlot(slots?.terminalHeading, tok, <>Candidate update</>)
              : resolveSlot(slots?.heading, tok, <>Candidate progress update</>)}
          </Heading>
          <Section>
            <Text style={text}>
              {resolveSlot(slots?.greeting, tok, <>Hi {partnerContactName},</>)}
            </Text>
            {isTerminal ? (
              <Text style={text}>
                {resolveSlot(
                  slots?.terminalBody,
                  tok,
                  <>
                    <strong>{candidateName}</strong>, whom you submitted for{" "}
                    <strong>{requisitionTitle}</strong> at {companyName}, is no longer progressing.
                    The application was moved to <strong>{stageLabel}</strong> on{" "}
                    {changedAtFormatted}.
                  </>,
                )}
              </Text>
            ) : (
              <Text style={text}>
                {resolveSlot(
                  slots?.body,
                  tok,
                  <>
                    <strong>{candidateName}</strong>, whom you submitted for{" "}
                    <strong>{requisitionTitle}</strong> at {companyName}, moved to{" "}
                    <strong>{stageLabel}</strong> on {changedAtFormatted}.
                  </>,
                )}
              </Text>
            )}
            <Text style={textMuted}>
              {resolveSlot(
                slots?.privacyNote,
                tok,
                <>
                  Stage and date are the whole update — interview feedback, assessments and internal
                  notes stay with the {companyName} hiring team.
                </>,
              )}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(slots?.signOff, tok, <>— The {companyName} sourcing team</>)}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: "#f6f8fa", fontFamily: "Inter, Arial, sans-serif" };
const container = { padding: "32px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "22px", fontWeight: 600, color: "#0f172a" };
const text = { fontSize: "15px", lineHeight: "22px", color: "#1f2937" };
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "16px" };
