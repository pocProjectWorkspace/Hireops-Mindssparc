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

export interface OfferDeclinedRecruiterProps {
  recruiterName: string;
  candidateName: string;
  positionTitle: string;
  declinedAtFormatted: string;
  declinedReason?: string;
  triageUrl: string;
}

/**
 * Sent to the recruiter when a candidate declines. Includes the
 * decline reason verbatim when present — recruiters want the raw
 * text, not a paraphrase.
 */
export function OfferDeclinedRecruiter({
  recruiterName,
  candidateName,
  positionTitle,
  declinedAtFormatted,
  declinedReason,
  triageUrl,
}: OfferDeclinedRecruiterProps) {
  return (
    <Html>
      <Head />
      <Preview>{`${candidateName} declined the offer for ${positionTitle}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Offer declined</Heading>
          <Section>
            <Text style={text}>Hi {recruiterName},</Text>
            <Text style={text}>
              <strong>{candidateName}</strong> declined the offer for{" "}
              <strong>{positionTitle}</strong> on {declinedAtFormatted}.
            </Text>
            {declinedReason ? (
              <Section style={reasonBox}>
                <Text style={reasonLabel}>Reason given:</Text>
                <Text style={reasonText}>{declinedReason}</Text>
              </Section>
            ) : (
              <Text style={text}>No reason was provided.</Text>
            )}
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
const reasonBox = {
  backgroundColor: "#fef3c7",
  border: "1px solid #fcd34d",
  borderRadius: "6px",
  padding: "12px 16px",
  margin: "12px 0",
};
const reasonLabel = { fontSize: "12px", fontWeight: 600, color: "#92400e", margin: "0" };
const reasonText = {
  fontSize: "14px",
  color: "#1f2937",
  margin: "4px 0 0",
  whiteSpace: "pre-wrap" as const,
};
