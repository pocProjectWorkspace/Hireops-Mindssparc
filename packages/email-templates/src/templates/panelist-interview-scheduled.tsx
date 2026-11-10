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
import { resolveSlot, type SlotOverrides } from "../slots";

export interface PanelistInterviewScheduledProps {
  panelistName: string;
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  /** Pre-formatted, zone label included. */
  interviewWhenFormatted: string;
  modeLabel: string;
  durationMinutes: number;
  meetingUrl: string;
  briefUrl: string;
  /** Raw ISO start + interview id — build the .ics (not rendered). */
  interviewStartIso?: string;
  interviewId?: string;
  slots?: SlotOverrides;
}

/**
 * PC-9 — sent to each panellist when a round is booked through a candidate's
 * slot pick (the candidate gets the existing invitation). Carries a REAL .ics
 * built by the same generator as the candidate's — no calendar API, no sync.
 */
export function PanelistInterviewScheduled({
  panelistName,
  candidateName,
  companyName,
  positionTitle,
  roundName,
  interviewWhenFormatted,
  modeLabel,
  durationMinutes,
  meetingUrl,
  briefUrl,
  slots,
}: PanelistInterviewScheduledProps) {
  const tok = { panelistName, candidateName, companyName, positionTitle, roundName };
  return (
    <Html>
      <Head />
      <Preview>{`Interview booked: ${candidateName}, ${roundName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>{resolveSlot(slots?.heading, tok, <>Interview booked</>)}</Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {panelistName},</>)}</Text>
            <Text style={text}>
              {resolveSlot(
                slots?.intro,
                tok,
                <>
                  {candidateName} has booked the {roundName} round for {positionTitle}. You&rsquo;re
                  on the panel. The calendar file is attached.
                </>,
              )}
            </Text>
            <Section style={summaryBox}>
              <Text style={summaryLine}>
                <strong>When:</strong> {interviewWhenFormatted}
              </Text>
              <Text style={summaryLine}>
                <strong>Format:</strong> {modeLabel} · {durationMinutes} minutes
              </Text>
              {meetingUrl ? (
                <Text style={summaryLine}>
                  <strong>Meeting link:</strong> {meetingUrl}
                </Text>
              ) : null}
            </Section>
            <Section style={{ textAlign: "center", margin: "24px 0" }}>
              <Link href={briefUrl} style={button}>
                {resolveSlot(slots?.ctaLabel, tok, <>Open the interview brief</>)}
              </Link>
            </Section>
            <Text style={textMuted}>
              {resolveSlot(
                slots?.footer,
                tok,
                <>
                  If you can no longer attend, use &ldquo;Can&rsquo;t attend&rdquo; on the brief and
                  the candidate will be offered new times automatically.
                </>,
              )}
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
