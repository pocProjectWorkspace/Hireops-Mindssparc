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

export interface CandidateAccountActivationProps {
  candidateName: string;
  companyName: string;
  activationUrl: string;
}

/**
 * Sent when a candidate requests account activation from the candidate
 * login page (CAND-01). One warm paragraph + a single button to
 * /candidate/activate/[token], where they set a password and their account
 * is created. The link is single-use and short-lived; the copy says so.
 *
 * Deliberately does NOT enumerate: this email only ever goes to a person who
 * already exists in the tenant, and the request endpoint returns the same
 * "if the email exists…" response either way, so a stranger never learns
 * whether an account exists.
 */
export function CandidateAccountActivation({
  candidateName,
  companyName,
  activationUrl,
}: CandidateAccountActivationProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Activate your ${companyName} candidate account`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Activate your account</Heading>
          <Section>
            <Text style={text}>Hi {candidateName},</Text>
            <Text style={text}>
              You can now follow your applications and interviews with{" "}
              <strong>{companyName}</strong> in one place. Set a password to activate your candidate
              account.
            </Text>
            <Section style={{ textAlign: "center", margin: "28px 0" }}>
              <Link href={activationUrl} style={button}>
                Set your password
              </Link>
            </Section>
            <Text style={textMuted}>
              This link is private to you and can be used once. If it expires, just request a new
              one from the sign-in page. If you weren&rsquo;t expecting this, you can safely ignore
              it.
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
const button = {
  backgroundColor: "#4f46e5",
  color: "#ffffff",
  padding: "12px 28px",
  borderRadius: "6px",
  textDecoration: "none",
  fontWeight: 600,
  display: "inline-block",
};
