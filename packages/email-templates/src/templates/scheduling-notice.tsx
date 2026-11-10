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

export interface SchedulingNoticeProps {
  recipientName: string;
  candidateName: string;
  positionTitle: string;
  roundName: string;
  /** Plain-text detail composed by the caller (e.g. "Asha can't attend (travel)."). */
  detail: string;
  actionUrl: string;
  slots?: SlotOverrides;
}

/**
 * PC-10 — "rescheduling in progress", to the recruiter and the remaining
 * panellists when a round is being moved. Informational: the candidate has
 * already been sent new times; nobody needs to chase.
 */
export function PanelistInterviewRescheduling(props: SchedulingNoticeProps) {
  const { recipientName, candidateName, positionTitle, roundName, detail, actionUrl, slots } =
    props;
  const tok = { recipientName, candidateName, positionTitle, roundName };
  return (
    <Html>
      <Head />
      <Preview>{`Rescheduling in progress: ${candidateName}, ${roundName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>Rescheduling in progress</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {recipientName},</>)}</Text>
            <Text style={text}>
              {resolveSlot(
                slots?.intro,
                tok,
                <>
                  The {roundName} round with {candidateName} for {positionTitle} is being
                  rescheduled. The candidate has been sent new times to choose from; you&rsquo;ll
                  get a fresh invite once they pick one.
                </>,
              )}
            </Text>
            {detail ? <Text style={textMuted}>{detail}</Text> : null}
            <Section style={{ textAlign: "center", margin: "24px 0" }}>
              <Link href={actionUrl} style={button}>
                {resolveSlot(slots?.ctaLabel, tok, <>Open interviews</>)}
              </Link>
            </Section>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * PC-8 — the recruiter's action-needed alert: no common slot could be found
 * (or none was left to re-offer), so a human has to step in.
 */
export function RecruiterSchedulingAlert(props: SchedulingNoticeProps) {
  const { recipientName, candidateName, positionTitle, roundName, detail, actionUrl, slots } =
    props;
  const tok = { recipientName, candidateName, positionTitle, roundName };
  return (
    <Html>
      <Head />
      <Preview>{`Action needed: no interview slot for ${candidateName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>No common interview slot</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {recipientName},</>)}</Text>
            <Text style={text}>
              {resolveSlot(
                slots?.intro,
                tok,
                <>
                  We couldn&rsquo;t find a time when the whole panel is free for the {roundName}{" "}
                  round with {candidateName} ({positionTitle}). Please widen the panel, ask a
                  panellist to add availability, or schedule a time manually.
                </>,
              )}
            </Text>
            {detail ? <Text style={textMuted}>{detail}</Text> : null}
            <Section style={{ textAlign: "center", margin: "24px 0" }}>
              <Link href={actionUrl} style={button}>
                {resolveSlot(slots?.ctaLabel, tok, <>Open interviews</>)}
              </Link>
            </Section>
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
const button = {
  backgroundColor: "#4f46e5",
  color: "#ffffff",
  padding: "12px 28px",
  borderRadius: "6px",
  textDecoration: "none",
  fontWeight: 600,
  display: "inline-block",
};
