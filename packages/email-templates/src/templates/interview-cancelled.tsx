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

export interface InterviewCancelledProps {
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
}

/**
 * POLISH-01 (Item B) — sent to the candidate when a recruiter cancels a
 * scheduled interview round (cancelInterview). Deliberately warm and
 * reassuring: a cancellation is unsettling, so the copy makes clear the
 * candidate is still in the process and the team will follow up. NO meeting
 * link and NO CTA — there is nothing for the candidate to click; a
 * rescheduled round sends its own fresh invitation with a confirm link.
 *
 * All display values are pre-formatted by the caller.
 */
export function InterviewCancelled({
  candidateName,
  companyName,
  positionTitle,
  roundName,
}: InterviewCancelledProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Your ${roundName} interview for ${positionTitle} has been cancelled`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Interview Cancelled</Heading>
          <Section>
            <Text style={text}>Hi {candidateName},</Text>
            <Text style={text}>
              We&rsquo;re writing to let you know that your <strong>{roundName}</strong> interview
              for the <strong>{positionTitle}</strong> role at <strong>{companyName}</strong> has
              been cancelled.
            </Text>
            <Text style={text}>
              This does not affect your standing in the process — you remain an active candidate.
              Our recruiting team will be in touch shortly with next steps, and if a new time is
              needed you&rsquo;ll receive a fresh invitation to confirm.
            </Text>
            <Text style={text}>
              If you have any questions in the meantime, simply reply to your recruiter.
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
