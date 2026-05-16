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

export interface StageAdvancedProps {
  candidateName: string;
  positionTitle: string;
  companyName: string;
  newStageLabel: string;
  /** Optional signed-link URL — present for stages that ask the candidate to act (e.g. accept offer). */
  actionUrl?: string;
  actionLabel?: string;
}

/**
 * Sent when an application advances to a stage the candidate should
 * know about. The recruiter-side "moved to recruiter_review" is NOT
 * candidate-visible; the dispatcher decides which transitions emit
 * this template.
 */
export function StageAdvanced({
  candidateName,
  positionTitle,
  companyName,
  newStageLabel,
  actionUrl,
  actionLabel,
}: StageAdvancedProps) {
  return (
    <Html>
      <Head />
      <Preview>Update on your application for {positionTitle}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Your application has moved forward</Heading>
          <Section>
            <Text style={text}>Hi {candidateName},</Text>
            <Text style={text}>
              Your application for <strong>{positionTitle}</strong> at {companyName} has been
              advanced to <strong>{newStageLabel}</strong>.
            </Text>
            {actionUrl && actionLabel ? (
              <Text style={text}>
                <Link href={actionUrl} style={link}>
                  {actionLabel}
                </Link>
              </Text>
            ) : (
              <Text style={text}>
                The recruiting team will reach out with next steps shortly.
              </Text>
            )}
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
const link = { color: "#2563eb", textDecoration: "underline" };
