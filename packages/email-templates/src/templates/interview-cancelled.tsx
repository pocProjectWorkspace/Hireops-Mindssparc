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
import { resolveSlot, type SlotOverrides } from "../slots";

export interface InterviewCancelledProps {
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
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
  slots,
}: InterviewCancelledProps) {
  const tok = { candidateName, companyName, positionTitle, roundName };
  return (
    <Html>
      <Head />
      <Preview>{`Your ${roundName} interview for ${positionTitle} has been cancelled`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>{resolveSlot(slots?.heading, tok, <>Interview Cancelled</>)}</Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {candidateName},</>)}</Text>
            {/*
              The inline whitespace around the <strong> data below is
              byte-significant to the react-email output; reflowing it inserts
              {" "} at new wrap points and changes the rendered HTML. Frozen with
              prettier-ignore to keep the no-override render byte-identical to the
              pre-T1.4 template.
            */}
            {/* prettier-ignore */}
            <Text style={text}>
              {resolveSlot(
                slots?.body1,
                tok,
                <>
                  We&rsquo;re writing to let you know that your <strong>{roundName}</strong> interview
                  for the <strong>{positionTitle}</strong> role at <strong>{companyName}</strong> has
                  been cancelled.
                </>,
              )}
            </Text>
            <Text style={text}>
              {resolveSlot(
                slots?.body2,
                tok,
                <>
                  This does not affect your standing in the process — you remain an active
                  candidate. Our recruiting team will be in touch shortly with next steps, and if a
                  new time is needed you&rsquo;ll receive a fresh invitation to confirm.
                </>,
              )}
            </Text>
            <Text style={text}>
              {resolveSlot(
                slots?.body3,
                tok,
                <>If you have any questions in the meantime, simply reply to your recruiter.</>,
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
