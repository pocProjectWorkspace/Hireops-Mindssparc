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
}

/**
 * Sent to a candidate after submitApplication succeeds. The lightest
 * possible "we got it" — sets recipient expectation that next contact
 * comes from a recruiter and references the position they applied to
 * so a candidate applying to multiple roles can tell them apart.
 */
export function ApplicationReceived({
  candidateName,
  positionTitle,
  companyName,
}: ApplicationReceivedProps) {
  return (
    <Html>
      <Head />
      <Preview>{`We've received your application for ${positionTitle} at ${companyName}`}</Preview>
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
            <Text style={textMuted}>— The {companyName} recruiting team</Text>
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
