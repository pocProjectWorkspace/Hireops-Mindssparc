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

export interface PartnerSubmissionReceivedProps {
  /** The submitting partner user, as partner_users.full_name has them. */
  partnerContactName: string;
  /** The candidate the partner submitted. */
  candidateName: string;
  /** The requisition the submission landed against (position title). */
  requisitionTitle: string;
  /** The hiring organisation — the tenant's display name (e.g. "Kyndryl"). */
  companyName: string;
  /** Human-readable submission date, e.g. "13 August 2026". */
  submittedAtFormatted: string;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * P0.4 — the partner's receipt for a candidate they submitted.
 *
 * Sent from partnerSubmitCandidate on the `created` and `added_to_existing`
 * outcomes, to the partner user who submitted. Confirms the submission landed
 * and is in the pipeline; it is NOT a screening outcome and must not read like
 * one.
 *
 * PRIVACY (requirements.md §6.3): a partner-facing email carries candidate
 * name + requisition + date and nothing else. No score, no parse output, no
 * recruiter identity, no mention of any other partner. That posture is why
 * this template has no props beyond the five above — there is nothing here to
 * leak.
 */
export function PartnerSubmissionReceived({
  partnerContactName,
  candidateName,
  requisitionTitle,
  companyName,
  submittedAtFormatted,
  slots,
}: PartnerSubmissionReceivedProps) {
  const tok = {
    partnerContactName,
    candidateName,
    requisitionTitle,
    companyName,
    submittedAtFormatted,
  };
  return (
    <Html>
      <Head />
      <Preview>{`${companyName} received your submission of ${candidateName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>{resolveSlot(slots?.heading, tok, <>Submission received</>)}</Heading>
          <Section>
            <Text style={text}>
              {resolveSlot(slots?.greeting, tok, <>Hi {partnerContactName},</>)}
            </Text>
            <Text style={text}>
              {resolveSlot(
                slots?.body,
                tok,
                <>
                  <strong>{companyName}</strong> has received your submission of{" "}
                  <strong>{candidateName}</strong> for <strong>{requisitionTitle}</strong> on{" "}
                  {submittedAtFormatted}. The candidate is in the pipeline and will be reviewed with
                  everyone else under consideration for this role.
                </>,
              )}
            </Text>
            <Text style={text}>
              {resolveSlot(
                slots?.nextStepsNote,
                tok,
                <>
                  You&rsquo;ll get an update here whenever this candidate reaches a new stage. No
                  action is needed from you in the meantime.
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
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "24px" };
