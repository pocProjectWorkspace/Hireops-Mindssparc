/** @jsxRuntime automatic @jsxImportSource react */
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

export interface OfferAcceptedRecruiterProps {
  recruiterName: string;
  candidateName: string;
  positionTitle: string;
  acceptedAtFormatted: string;
  joiningDate: string;
  triageUrl: string;
}

/**
 * Sent to the recruiter the moment a candidate accepts. Concise
 * "good news" note + a link back to the triage board where the
 * application now shows in the offer_accepted stage.
 */
export function OfferAcceptedRecruiter({
  recruiterName,
  candidateName,
  positionTitle,
  acceptedAtFormatted,
  joiningDate,
  triageUrl,
}: OfferAcceptedRecruiterProps) {
  return (
    <Html>
      <Head />
      <Preview>{`${candidateName} accepted the offer for ${positionTitle}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Offer accepted</Heading>
          <Section>
            <Text style={text}>Hi {recruiterName},</Text>
            <Text style={text}>
              <strong>{candidateName}</strong> accepted the offer for{" "}
              <strong>{positionTitle}</strong> on {acceptedAtFormatted}. Joining date:{" "}
              <strong>{joiningDate}</strong>.
            </Text>
            <Text style={text}>
              The Workday Hire event has been queued. Onboarding paperwork follows next.
            </Text>
            <Text style={text}>
              <Link href={triageUrl} style={link}>
                Open triage
              </Link>
            </Text>
            <Text style={textMuted}>— HireOps</Text>
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
const link = { color: "#2563eb", textDecoration: "underline" };