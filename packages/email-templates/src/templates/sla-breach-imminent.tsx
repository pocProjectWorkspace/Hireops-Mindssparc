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

export interface SlaBreachImminentProps {
  recruiterName: string;
  applicationCount: number;
  triageUrl: string;
}

/**
 * Sent by the sla-imminent scan when a recruiter has applications
 * within X hours of breaching their stage SLA. Batched per recruiter
 * — one email per scan, not one per application.
 *
 * The link is internal (not a signed link); the recruiter is
 * authenticated. We just need them to click into /triage where the
 * Hot Zone surfaces the breaches.
 */
export function SlaBreachImminent({
  recruiterName,
  applicationCount,
  triageUrl,
}: SlaBreachImminentProps) {
  const noun = applicationCount === 1 ? "application" : "applications";
  return (
    <Html>
      <Head />
      <Preview>{`${applicationCount} ${noun} near SLA breach`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Heads up — SLA breach imminent</Heading>
          <Section>
            <Text style={text}>Hi {recruiterName},</Text>
            <Text style={text}>
              You have <strong>{String(applicationCount)}</strong> {noun} approaching the stage
              SLA threshold. Quickest path: open the Hot Zone on your triage board.
            </Text>
            <Text style={text}>
              <Link href={triageUrl} style={link}>
                Open triage
              </Link>
            </Text>
            <Text style={textMuted}>
              You&rsquo;re receiving this because you&rsquo;re a primary recruiter on these
              requisitions.
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
const link = { color: "#2563eb", textDecoration: "underline" };