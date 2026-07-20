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

export type SlaOpsSeverity = "low" | "medium" | "high";

export interface SlaOpsAlertProps {
  /** Composed by the worker — carries the count/context, e.g.
   * "3 applications near SLA breach" or "5 applications open ≥ 3 days". */
  headline: string;
  /** One-sentence body describing the operational situation. */
  bodyLine: string;
  /** Present for escalation alerts; omitted for the plain SLA cc. */
  severity?: SlaOpsSeverity | null;
  actionUrl: string;
  actionLabel: string;
  /** Honest "why you received this" — states the System Setup config that
   * drove the send (a configured recipient, or an escalation rule). */
  reason: string;
}

/**
 * Operational alert to a recipient configured in the admin System Setup
 * screen (Email Alerts recipients, or an Escalation Rule recipient).
 *
 * Deliberately distinct from `recruiter.sla_breach_imminent`: that
 * template greets the OWNING recruiter ("you're a primary recruiter on
 * these requisitions") — copy that would be untrue for an ops mailbox or
 * an escalation lead. This template's copy is honest for whoever the
 * admin configured, and names the reason they were notified.
 *
 * No delivery/read receipts are implied — email has none.
 */
export function SlaOpsAlert({
  headline,
  bodyLine,
  severity,
  actionUrl,
  actionLabel,
  reason,
}: SlaOpsAlertProps) {
  return (
    <Html>
      <Head />
      <Preview>{headline}</Preview>
      <Body style={body}>
        <Container style={container}>
          {severity ? <Text style={badge(severity)}>{severity.toUpperCase()} SEVERITY</Text> : null}
          <Heading style={h1}>{headline}</Heading>
          <Section>
            <Text style={text}>{bodyLine}</Text>
            <Text style={text}>
              <Link href={actionUrl} style={link}>
                {actionLabel}
              </Link>
            </Text>
            <Text style={textMuted}>{reason}</Text>
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
const link = { color: "#2563eb", textDecoration: "underline" };
const SEVERITY_COLOR: Record<SlaOpsSeverity, string> = {
  low: "#0369a1",
  medium: "#b45309",
  high: "#b91c1c",
};
function badge(severity: SlaOpsSeverity) {
  return {
    display: "inline-block",
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: SEVERITY_COLOR[severity],
    marginBottom: "4px",
  };
}
