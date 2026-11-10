/** @jsxRuntime automatic @jsxImportSource react */
import {
  Body,
  Button,
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

/**
 * PC-14 — pre-joining engagement emails (candidate) + the PC-15 joining-risk
 * signal alert (recruiter).
 *
 * One component per audience; the candidate one renders five variants (one
 * per journey step / TemplateKey). Every static text run is a named slot the
 * tenant can override from /admin/email-templates; the defaults below are
 * byte-identical to EMAIL_TEMPLATE_CATALOG. Data — names, dates, the company
 * update's own title/body/link, the tenant's first-day info, the pulse link —
 * stays code-owned and is rendered as escaped text, never HTML.
 */

export type PreJoiningVariant = "welcome" | "pulse" | "company_update" | "two_weeks" | "one_week";

export interface PreJoiningEmailProps {
  variant: PreJoiningVariant;
  candidateName: string;
  companyName: string;
  positionTitle: string;
  /** Human date, e.g. "8 February 2027". */
  joiningDate: string;
  /** Present on pulse-carrying variants (pulse, two_weeks). */
  pulseUrl?: string | null;
  /** company_update only — tenant-authored content. */
  updateTitle?: string | null;
  updateBody?: string | null;
  updateLinkUrl?: string | null;
  updateVideoUrl?: string | null;
  /** one_week only — the tenant's first-day information (free text). */
  firstDayInfo?: string | null;
  /** Reply-to address with the routing token — dispatcher-only, not rendered. */
  replyTo?: string | null;
  /** From display name — dispatcher-only, not rendered. */
  senderName?: string | null;
  slots?: SlotOverrides;
}

/** Default copy per variant — mirrored in EMAIL_TEMPLATE_CATALOG. */
export const PRE_JOINING_DEFAULT_COPY: Record<
  PreJoiningVariant,
  { heading: string; intro: string; preview: string }
> = {
  welcome: {
    heading: "We're glad you're joining us",
    intro:
      "Thank you for accepting our offer for {positionTitle}. We're looking forward to welcoming you on {joiningDate}. Between now and then we'll check in every so often with news from the team and the practical details for your first day.",
    preview: "Welcome aboard — we're looking forward to {joiningDate}",
  },
  pulse: {
    heading: "A quick check-in",
    intro:
      "We hope your notice period is going smoothly. One quick question, so we can help early if anything has changed:",
    preview: "Are you still on track to join on {joiningDate}?",
  },
  company_update: {
    heading: "News from {companyName}",
    intro: "Here's a little news from the team you'll be joining:",
    preview: "News from the team you're joining",
  },
  two_weeks: {
    heading: "Two weeks to go",
    intro:
      "You join us as {positionTitle} in two weeks, on {joiningDate}. We're getting everything ready for you.",
    preview: "Two weeks until you join us on {joiningDate}",
  },
  one_week: {
    heading: "One week to go",
    intro: "You join us on {joiningDate}. Here's what you need to know for your first day:",
    preview: "Your first day is {joiningDate}",
  },
};

export const PRE_JOINING_PULSE_QUESTION = "Are you still on track to join on {joiningDate}?";
export const PRE_JOINING_PULSE_CTA = "Answer the check-in (takes 10 seconds)";
export const PRE_JOINING_REPLY_NOTE =
  "If anything changes or you have a question, just reply to this email — it reaches your recruiter.";
export const PRE_JOINING_FIRST_DAY_FALLBACK =
  "Your recruiter will share your reporting time and location before your first day.";
export const PRE_JOINING_SIGN_OFF = "— The {companyName} team";

function fill(text: string, tok: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => tok[k] ?? m);
}

function paragraphs(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function PreJoiningEmail(props: PreJoiningEmailProps) {
  const { variant, candidateName, companyName, positionTitle, joiningDate, slots } = props;
  const tok = { candidateName, companyName, positionTitle, joiningDate };
  const copy = PRE_JOINING_DEFAULT_COPY[variant];
  const showPulse = (variant === "pulse" || variant === "two_weeks") && !!props.pulseUrl;

  return (
    <Html>
      <Head />
      <Preview>{fill(copy.preview, tok)}</Preview>
      <Body style={bodyStyle}>
        <Container style={container}>
          <Heading style={h1}>
            {variant === "company_update" && props.updateTitle
              ? props.updateTitle
              : resolveSlot(slots?.heading, tok, <>{fill(copy.heading, tok)}</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {candidateName},</>)}</Text>
            <Text style={text}>{resolveSlot(slots?.intro, tok, <>{fill(copy.intro, tok)}</>)}</Text>

            {variant === "company_update"
              ? paragraphs(props.updateBody).map((p, i) => (
                  <Text key={i} style={text}>
                    {p}
                  </Text>
                ))
              : null}
            {variant === "company_update" && props.updateVideoUrl ? (
              <Text style={text}>
                <Link href={props.updateVideoUrl} style={link}>
                  {resolveSlot(slots?.videoLabel, tok, <>Watch the video</>)}
                </Link>
              </Text>
            ) : null}
            {variant === "company_update" && props.updateLinkUrl ? (
              <Text style={text}>
                <Link href={props.updateLinkUrl} style={link}>
                  {resolveSlot(slots?.linkLabel, tok, <>Read more</>)}
                </Link>
              </Text>
            ) : null}

            {variant === "one_week" ? (
              paragraphs(props.firstDayInfo).length > 0 ? (
                <Section style={infoBox}>
                  {paragraphs(props.firstDayInfo).map((p, i) => (
                    <Text key={i} style={infoText}>
                      {p}
                    </Text>
                  ))}
                </Section>
              ) : (
                <Text style={text}>
                  {resolveSlot(slots?.firstDayFallback, tok, <>{PRE_JOINING_FIRST_DAY_FALLBACK}</>)}
                </Text>
              )
            ) : null}

            {showPulse ? (
              <Section style={pulseBox}>
                <Text style={pulseQuestion}>
                  {resolveSlot(
                    slots?.pulseQuestion,
                    tok,
                    <>{fill(PRE_JOINING_PULSE_QUESTION, tok)}</>,
                  )}
                </Text>
                <Button href={props.pulseUrl ?? undefined} style={button}>
                  {resolveSlot(slots?.pulseCta, tok, <>{PRE_JOINING_PULSE_CTA}</>)}
                </Button>
              </Section>
            ) : null}

            <Text style={textMuted}>
              {resolveSlot(slots?.replyNote, tok, <>{PRE_JOINING_REPLY_NOTE}</>)}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(slots?.signOff, tok, <>{fill(PRE_JOINING_SIGN_OFF, tok)}</>)}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export interface JoiningRiskSignalRecruiterProps {
  recruiterName: string;
  candidateName: string;
  positionTitle: string;
  joiningDate: string;
  signalLabel: string;
  /** "Reply to an engagement email" | "Pulse check-in answer". */
  sourceLabel: string;
  /** The candidate's own words (verified verbatim), or null. */
  quote?: string | null;
  timelineUrl: string;
  slots?: SlotOverrides;
}

export const JOINING_RISK_NOTE =
  "This is what the candidate said, not a prediction. Read the full message on the timeline and decide what to do.";

export function JoiningRiskSignalRecruiter(props: JoiningRiskSignalRecruiterProps) {
  const { recruiterName, candidateName, positionTitle, joiningDate, signalLabel, slots } = props;
  const tok = { recruiterName, candidateName, positionTitle, joiningDate, signalLabel };
  return (
    <Html>
      <Head />
      <Preview>{`${candidateName}: ${signalLabel}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>Pre-joining signal: {signalLabel}</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {recruiterName},</>)}</Text>
            <Text style={text}>
              {resolveSlot(
                slots?.body,
                tok,
                <>
                  <strong>{candidateName}</strong> ({positionTitle}, joining {joiningDate}) —{" "}
                  {signalLabel}.
                </>,
              )}
            </Text>
            <Text style={textMuted}>Source: {props.sourceLabel}</Text>
            {props.quote ? (
              <Section style={quoteBox}>
                <Text style={quoteLabel}>In their words:</Text>
                <Text style={quoteText}>“{props.quote}”</Text>
              </Section>
            ) : null}
            <Text style={text}>{resolveSlot(slots?.note, tok, <>{JOINING_RISK_NOTE}</>)}</Text>
            <Text style={text}>
              <Link href={props.timelineUrl} style={link}>
                {resolveSlot(slots?.ctaLabel, tok, <>Open the engagement timeline</>)}
              </Link>
            </Text>
            <Text style={textMuted}>{resolveSlot(slots?.signOff, tok, <>— HireOps</>)}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = { backgroundColor: "#f6f8fa", fontFamily: "Inter, Arial, sans-serif" };
const container = { padding: "32px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "22px", fontWeight: 600, color: "#0f172a" };
const text = { fontSize: "15px", lineHeight: "22px", color: "#1f2937" };
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "20px" };
const link = { color: "#2563eb", textDecoration: "underline" };
const pulseBox = {
  backgroundColor: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: "8px",
  padding: "16px",
  margin: "16px 0",
};
const pulseQuestion = { fontSize: "16px", fontWeight: 600, color: "#1e3a8a", margin: "0 0 12px" };
const button = {
  backgroundColor: "#2563eb",
  color: "#ffffff",
  borderRadius: "6px",
  padding: "10px 16px",
  fontSize: "14px",
  textDecoration: "none",
};
const infoBox = {
  backgroundColor: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  padding: "12px 16px",
  margin: "12px 0",
};
const infoText = {
  fontSize: "14px",
  color: "#1f2937",
  margin: "4px 0",
  whiteSpace: "pre-wrap" as const,
};
const quoteBox = {
  backgroundColor: "#fef3c7",
  border: "1px solid #fcd34d",
  borderRadius: "6px",
  padding: "12px 16px",
  margin: "12px 0",
};
const quoteLabel = { fontSize: "12px", fontWeight: 600, color: "#92400e", margin: "0" };
const quoteText = {
  fontSize: "14px",
  color: "#1f2937",
  margin: "4px 0 0",
  whiteSpace: "pre-wrap" as const,
};
