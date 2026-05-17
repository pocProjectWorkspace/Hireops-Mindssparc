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

export interface OfferExtendedProps {
  candidateName: string;
  companyName: string;
  positionTitle: string;
  joiningDate: string;
  baseSalaryInrFormatted: string;
  location: string;
  expiryAtFormatted: string;
  acceptUrl: string;
}

/**
 * Sent to the candidate when an offer is extended. The single CTA is
 * the signed-link "Review & Respond" button — the candidate clicks
 * through to the /offer/[token] page where they confirm their name +
 * accept/decline.
 *
 * Salary is pre-formatted by the caller (we don't try to format paise
 * → INR display in the template).
 */
export function OfferExtended({
  candidateName,
  companyName,
  positionTitle,
  joiningDate,
  baseSalaryInrFormatted,
  location,
  expiryAtFormatted,
  acceptUrl,
}: OfferExtendedProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Your offer of employment for ${positionTitle} at ${companyName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Offer of Employment</Heading>
          <Section>
            <Text style={text}>Hi {candidateName},</Text>
            <Text style={text}>
              We&rsquo;re pleased to extend an offer of employment at{" "}
              <strong>{companyName}</strong> for the role of <strong>{positionTitle}</strong>.
            </Text>
            <Section style={summaryBox}>
              <Text style={summaryLine}>
                <strong>Position:</strong> {positionTitle}
              </Text>
              <Text style={summaryLine}>
                <strong>Joining date:</strong> {joiningDate}
              </Text>
              <Text style={summaryLine}>
                <strong>Base salary:</strong> {baseSalaryInrFormatted}
              </Text>
              <Text style={summaryLine}>
                <strong>Location:</strong> {location}
              </Text>
              <Text style={summaryLine}>
                <strong>Expires:</strong> {expiryAtFormatted}
              </Text>
            </Section>
            <Text style={text}>
              Please review the full offer and confirm your decision below.
            </Text>
            <Section style={{ textAlign: "center", margin: "24px 0" }}>
              <Link href={acceptUrl} style={button}>
                Review &amp; Respond
              </Link>
            </Section>
            <Text style={textMuted}>
              This link is private to you and expires on {expiryAtFormatted}. If you didn&rsquo;t
              request this offer, please ignore this email.
            </Text>
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
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "16px" };
const summaryBox = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "16px 20px",
  margin: "16px 0",
};
const summaryLine = { fontSize: "14px", lineHeight: "22px", color: "#1f2937", margin: "4px 0" };
const button = {
  backgroundColor: "#16a34a",
  color: "#ffffff",
  padding: "12px 28px",
  borderRadius: "6px",
  textDecoration: "none",
  fontWeight: 600,
  display: "inline-block",
};
