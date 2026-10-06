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

export interface ApplicationClosedProps {
  candidateName: string;
  positionTitle: string;
  companyName: string;
  /** Why the application closed: the team declined it, or the candidate withdrew. */
  outcome: "not_selected" | "withdrawn";
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * Sent when an application leaves the pipeline: the recruiting team moves it to
 * recruiter_rejected, or it is withdrawn. Replaces candidate.stage_advanced for
 * those two stages, whose "moved forward" heading read as good news to a
 * candidate who was being turned down. Courteous and final: no CTA, no stage
 * label, no reason (reasons are internal).
 */
export function ApplicationClosed({
  candidateName,
  positionTitle,
  companyName,
  outcome,
  slots,
}: ApplicationClosedProps) {
  const tok = { candidateName, positionTitle, companyName };
  return (
    <Html>
      <Head />
      <Preview>An update on your application for {positionTitle}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>An update on your application</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {candidateName},</>)}</Text>
            {outcome === "withdrawn" ? (
              <Text style={text}>
                {resolveSlot(
                  slots?.withdrawnBody,
                  tok,
                  <>
                    Your application for <strong>{positionTitle}</strong> at {companyName} has been
                    withdrawn. Thank you for the time you spent with us.
                  </>,
                )}
              </Text>
            ) : (
              <>
                <Text style={text}>
                  {resolveSlot(
                    slots?.body,
                    tok,
                    <>
                      Thank you for your interest in the <strong>{positionTitle}</strong> role at{" "}
                      {companyName}. After careful consideration, we won't be taking your
                      application further for this role.
                    </>,
                  )}
                </Text>
                <Text style={text}>
                  {resolveSlot(
                    slots?.closingNote,
                    tok,
                    <>We appreciate the time you invested and wish you every success.</>,
                  )}
                </Text>
              </>
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

const body = { backgroundColor: "#f6f8fa", fontFamily: "Inter, Arial, sans-serif" };
const container = { padding: "32px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "22px", fontWeight: 600, color: "#0f172a" };
const text = { fontSize: "15px", lineHeight: "22px", color: "#1f2937" };
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "32px" };
