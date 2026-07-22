/** @jsxRuntime automatic @jsxImportSource react */
import { Body, Container, Head, Html, Preview, Section, Text } from "@react-email/components";
import { resolveSlot, type SlotOverrides } from "../slots";

export interface AgentMessageProps {
  candidateName: string;
  positionTitle: string;
  companyName: string;
  /**
   * The agent-drafted, recruiter-approved message body. Plain text —
   * the prompt forbids markdown and HTML, and we render it as text
   * nodes regardless, so a model that ignores the instruction produces
   * visible tags rather than injected markup.
   */
  body: string;
  /** T1.4 — optional tenant copy overrides. The body is the approved draft
   * (never overridable); only the sign-off is exposed as a slot. */
  slots?: SlotOverrides;
}

/**
 * The shell for an agent-drafted, human-approved message to a candidate.
 *
 * Unlike every other template in this package, the copy is NOT owned
 * here — the body arrives from `draft_message` and has been through the
 * approval queue. This component only supplies the branded wrapper and
 * the sign-off, so an approved draft can never accidentally ship without
 * tenant context around it.
 *
 * Paragraphs are split on blank lines and rendered as separate <Text>
 * nodes; React escapes each one, so no `dangerouslySetInnerHTML` and no
 * HTML-injection path from model output into a candidate's inbox.
 */
export function AgentMessage({
  candidateName,
  positionTitle,
  companyName,
  body,
  slots,
}: AgentMessageProps) {
  const tok = { candidateName, positionTitle, companyName };
  // Defensive: a candidate-facing send must never crash on a missing or
  // non-string body. Coerce, then fall back to a plain greeting so the
  // email still goes out (the worker marks the row sent, not failed).
  const safeBody = typeof body === "string" ? body : "";
  const paragraphs = safeBody
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return (
    <Html>
      <Head />
      <Preview>
        A message about your application for {positionTitle} at {companyName}
      </Preview>
      <Body style={bodyStyle}>
        <Container style={container}>
          <Section>
            {paragraphs.length > 0 ? (
              paragraphs.map((paragraph, i) => (
                <Text key={i} style={text}>
                  {paragraph}
                </Text>
              ))
            ) : (
              <Text style={text}>Hi {candidateName},</Text>
            )}
            <Text style={textMuted}>
              {resolveSlot(slots?.signOff, tok, <>— The {companyName} recruiting team</>)}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = { backgroundColor: "#f6f8fa", fontFamily: "Inter, Arial, sans-serif" };
const container = { padding: "32px", maxWidth: "560px", margin: "0 auto" };
const text = { fontSize: "15px", lineHeight: "22px", color: "#1f2937" };
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "32px" };
