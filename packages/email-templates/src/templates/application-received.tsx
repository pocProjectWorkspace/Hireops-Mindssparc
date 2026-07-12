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

export interface ApplicationReceivedProps {
  candidateName: string;
  positionTitle: string;
  companyName: string;
  applicationReference: string;
}

/**
 * Sent to a candidate after submitApplication succeeds. The lightest
 * possible "we got it" — sets recipient expectation that next contact
 * comes from a recruiter and references the position they applied to
 * so a candidate applying to multiple roles can tell them apart.
 *
 * applicationReference is the short candidate-facing ID (first 8 chars
 * of the application UUID); they see the same value on the confirmation
 * page and can quote it in any follow-up.
 */
export function ApplicationReceived({
  candidateName,
  positionTitle,
  companyName,
  applicationReference,
}: ApplicationReceivedProps) {
  return (
    <Html>
      <Head />
      <Preview>{`We received your application for ${positionTitle}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Application received</Heading>
          <Section>
            <Text style={text}>Hi {candidateName},</Text>
            <Text style={text}>
              Thank you for applying to <strong>{positionTitle}</strong> at {companyName}. Our
              recruiting team will review your application and reach out within the next few
              business days if there&rsquo;s a fit.
            </Text>
            <Text style={text}>You don&rsquo;t need to do anything right now.</Text>
            <Text style={text}>
              Reference: <strong>{applicationReference}</strong>
            </Text>
            <Text style={textMuted}>— The {companyName} recruiting team</Text>
            <Text style={footer}>
              This is an automated message. Please don&rsquo;t reply to this email — replies are not
              monitored. If you need to reach the team, contact the recruiter who emails you next.
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
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "32px" };
const footer = { fontSize: "12px", color: "#94a3b8", marginTop: "24px", lineHeight: "18px" };
