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

export interface InterviewInvitationProps {
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  /** Pre-formatted date/time string (caller localises). Empty if TBC. */
  interviewWhenFormatted: string;
  /** "Video", "On-site" or "Phone" — caller maps the mode enum to a label. */
  modeLabel: string;
  durationMinutes: number;
  /** Meeting join URL if the round has one; empty string otherwise. */
  meetingUrl: string;
  confirmUrl: string;
  /** A13 — raw ISO start + stable interview id, used to build the .ics
   * attachment (not rendered in the email body). Optional so older enqueues
   * without them still render; a missing start simply yields no calendar file. */
  interviewStartIso?: string;
  interviewId?: string;
}

/**
 * Sent to the candidate when a recruiter schedules an interview round. The
 * single CTA is the signed-link "Confirm attendance" button — the candidate
 * clicks through to /interviews/confirm/[token] where they see the round
 * summary and confirm. Panel-side surfaces are INT-03; this email is the
 * candidate's only touchpoint for the round.
 *
 * All display values are pre-formatted by the caller (we don't localise
 * timestamps or map enums to labels in the template).
 */
export function InterviewInvitation({
  candidateName,
  companyName,
  positionTitle,
  roundName,
  interviewWhenFormatted,
  modeLabel,
  durationMinutes,
  meetingUrl,
  confirmUrl,
}: InterviewInvitationProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Your ${roundName} interview for ${positionTitle} at ${companyName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Interview Invitation</Heading>
          <Section>
            <Text style={text}>Hi {candidateName},</Text>
            <Text style={text}>
              You&rsquo;re invited to the <strong>{roundName}</strong> round for the{" "}
              <strong>{positionTitle}</strong> role at <strong>{companyName}</strong>.
            </Text>
            <Section style={summaryBox}>
              <Text style={summaryLine}>
                <strong>Round:</strong> {roundName}
              </Text>
              <Text style={summaryLine}>
                <strong>When:</strong> {interviewWhenFormatted || "To be confirmed"}
              </Text>
              <Text style={summaryLine}>
                <strong>Format:</strong> {modeLabel} · {durationMinutes} minutes
              </Text>
              {meetingUrl ? (
                <Text style={summaryLine}>
                  <strong>Meeting link:</strong>{" "}
                  <Link href={meetingUrl} style={inlineLink}>
                    {meetingUrl}
                  </Link>
                </Text>
              ) : null}
            </Section>
            <Text style={text}>Please confirm your attendance so we can finalise the panel.</Text>
            <Section style={{ textAlign: "center", margin: "24px 0" }}>
              <Link href={confirmUrl} style={button}>
                Confirm attendance
              </Link>
            </Section>
            <Text style={textMuted}>
              This link is private to you. If the timing doesn&rsquo;t work, reply to your recruiter
              to reschedule.
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
const inlineLink = { color: "#4f46e5", textDecoration: "underline" };
const summaryBox = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "16px 20px",
  margin: "16px 0",
};
const summaryLine = { fontSize: "14px", lineHeight: "22px", color: "#1f2937", margin: "4px 0" };
const button = {
  backgroundColor: "#4f46e5",
  color: "#ffffff",
  padding: "12px 28px",
  borderRadius: "6px",
  textDecoration: "none",
  fontWeight: 600,
  display: "inline-block",
};
