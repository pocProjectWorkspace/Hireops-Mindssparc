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

export interface InterviewSlotOfferProps {
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  durationMinutes: number;
  /** "initial" | "candidate_reschedule" | "panelist_unavailable" | "recruiter_reschedule". */
  reason: string;
  /** Pre-formatted slot lines in the tenant zone, zone label included. */
  slotLines: string[];
  /** Pre-formatted link expiry. */
  expiresAtFormatted: string;
  pickUrl: string;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * PC-9 — the candidate's "pick a time" email. One CTA: the signed link to the
 * pick page, which lists the same times in the candidate's OWN time zone (the
 * email can only show the company's zone, so it says so). The intro varies by
 * why the offer exists — a first booking, the candidate's own reschedule, or a
 * panellist who can no longer attend — so the candidate never has to ask what
 * happened.
 */
export function InterviewSlotOffer({
  candidateName,
  companyName,
  positionTitle,
  roundName,
  durationMinutes,
  reason,
  slotLines,
  expiresAtFormatted,
  pickUrl,
  slots,
}: InterviewSlotOfferProps) {
  const tok = { candidateName, companyName, positionTitle, roundName, expiresAtFormatted };
  const reasonLine =
    reason === "panelist_unavailable"
      ? resolveSlot(
          slots?.introPanelUnavailable,
          tok,
          <>
            Unfortunately one of your interviewers can no longer make the time we agreed for your{" "}
            <strong>{roundName}</strong> round for <strong>{positionTitle}</strong>. We&rsquo;re
            sorry for the change. Please pick a new time below.
          </>,
        )
      : reason === "candidate_reschedule" || reason === "recruiter_reschedule"
        ? resolveSlot(
            slots?.introReschedule,
            tok,
            <>
              Here are new times for your <strong>{roundName}</strong> round for{" "}
              <strong>{positionTitle}</strong>. Pick the one that suits you best.
            </>,
          )
        : resolveSlot(
            slots?.intro,
            tok,
            <>
              You&rsquo;re invited to the <strong>{roundName}</strong> round for the{" "}
              <strong>{positionTitle}</strong> role at <strong>{companyName}</strong>. Pick the time
              that suits you best.
            </>,
          );
  return (
    <Html>
      <Head />
      <Preview>{`Choose a time for your ${roundName} interview`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>Choose your interview time</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {candidateName},</>)}</Text>
            <Text style={text}>{reasonLine}</Text>
            <Section style={summaryBox}>
              <Text style={summaryLine}>
                <strong>Round:</strong> {roundName} · {durationMinutes} minutes
              </Text>
              {slotLines.map((line) => (
                <Text key={line} style={summaryLine}>
                  {line}
                </Text>
              ))}
            </Section>
            <Section style={{ textAlign: "center", margin: "24px 0" }}>
              <Link href={pickUrl} style={button}>
                {resolveSlot(slots?.ctaLabel, tok, <>Choose a time</>)}
              </Link>
            </Section>
            <Text style={textMuted}>
              {resolveSlot(
                slots?.privateNote,
                tok,
                <>
                  The page shows these times in your own time zone. This link is private to you and
                  works until {expiresAtFormatted}.
                </>,
              )}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(slots?.signOff, tok, <>— The {companyName} recruiting team</>)}
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
