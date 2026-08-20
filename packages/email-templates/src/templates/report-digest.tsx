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

export interface ReportDigestProps {
  /** Tenant display name — the digest is addressed on behalf of the company. */
  companyName: string;
  /** The CLOSED period the numbers cover, already formatted by the worker
   * (e.g. "10–16 August 2026" or "July 2026"). Never a live/partial window. */
  periodLabel: string;
  /** "weekly" / "monthly" — the configured cadence, lower-case, because it is
   * read inline in the intro sentence rather than as a heading. */
  cadenceLabel: string;
  hires: number;
  applications: number;
  activePipeline: number;
  /** Offers accepted ÷ extended, 1dp. NULL when no offer was extended in the
   * window — printed as an em dash, never as 0%. */
  offerAcceptanceRatePct: number | null;
  /** Median days application → hire, 2dp. NULL with no hires in the window. */
  medianTimeToFillDays: number | null;
  /** Age of the oldest still-open requisition, 2dp. NULL when none is open. */
  oldestOpenReqDays: number | null;
  actionUrl: string;
  /** Honest "why you received this" — names the configuration that drove the
   * send, because these recipients may not be HireOps users at all. */
  reason: string;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * R1.5a — the scheduled report digest: the executive board pack's six headline
 * numbers for the period that just closed, emailed to the mailboxes an admin
 * nominated in Admin → Report digests.
 *
 * Deliberately NOT `recruiter.sla_ops_alert`. That template is a single
 * headline + body line composed by its worker, which is the right shape for
 * "something needs attention now" and the wrong one for a stat block: six
 * labelled figures squeezed into one composed sentence is a paragraph nobody
 * reads, and it would have put the period label, the numbers, and the reason
 * line all inside one un-inspectable string. Here each figure is its own DATA
 * binding, so the copy stays overridable while the numbers stay code-owned.
 *
 * A null figure renders as an em dash, never as a zero: "no offer was extended
 * this week" and "nobody accepted" are different facts, and a board-facing email
 * that conflates them is worse than one that admits the gap. The note under the
 * block says so in words so a reader does not have to infer it.
 *
 * Every number here is the executive summary report's own number over the same
 * window — the digest composes, it does not compute (see
 * apps/api/src/lib/reports/executive-summary.ts). The CTA is an ordinary
 * internal link to /reports; a recipient who is not a HireOps user will land on
 * the login page, which is the honest outcome rather than a signed link handing
 * out report access by email.
 */
export function ReportDigest({
  companyName,
  periodLabel,
  cadenceLabel,
  hires,
  applications,
  activePipeline,
  offerAcceptanceRatePct,
  medianTimeToFillDays,
  oldestOpenReqDays,
  actionUrl,
  reason,
  slots,
}: ReportDigestProps) {
  const tok = {
    companyName,
    periodLabel,
    cadenceLabel,
    hires: String(hires),
    applications: String(applications),
    activePipeline: String(activePipeline),
  };
  return (
    <Html>
      <Head />
      <Preview>{`${companyName} hiring digest — ${periodLabel}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>{resolveSlot(slots?.heading, tok, <>Hiring digest</>)}</Heading>
          <Section>
            <Text style={text}>
              {resolveSlot(
                slots?.intro,
                tok,
                <>
                  Your {cadenceLabel} hiring digest for <strong>{companyName}</strong>, covering{" "}
                  <strong>{periodLabel}</strong>.
                </>,
              )}
            </Text>
            <Section style={summaryBox}>
              <Text style={summaryLine}>
                <strong>Hires:</strong> {String(hires)}
              </Text>
              <Text style={summaryLine}>
                <strong>Applications received:</strong> {String(applications)}
              </Text>
              <Text style={summaryLine}>
                <strong>Active pipeline:</strong> {String(activePipeline)}
              </Text>
              <Text style={summaryLine}>
                <strong>Offer acceptance:</strong> {formatPct(offerAcceptanceRatePct)}
              </Text>
              <Text style={summaryLine}>
                <strong>Median time to fill:</strong> {formatDays(medianTimeToFillDays)}
              </Text>
              <Text style={summaryLine}>
                <strong>Oldest open requisition:</strong> {formatDays(oldestOpenReqDays)}
              </Text>
            </Section>
            <Text style={textMuted}>
              {resolveSlot(
                slots?.dashNote,
                tok,
                <>
                  An em dash means there was nothing to measure in this period — no offer extended,
                  no hire made, or no requisition open. It is not a zero.
                </>,
              )}
            </Text>
            <Text style={text}>
              <Link href={actionUrl} style={link}>
                {resolveSlot(slots?.ctaLabel, tok, <>Open reports</>)}
              </Link>
            </Text>
            <Text style={textMuted}>{reason}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/** 1dp percent, or an em dash when the rate is undefined (empty denominator). */
function formatPct(pct: number | null): string {
  return pct === null ? "—" : `${pct.toFixed(1)}%`;
}

/** Whole-ish days (1dp), or an em dash when there is nothing to measure. */
function formatDays(days: number | null): string {
  return days === null ? "—" : `${days.toFixed(1)} days`;
}

const body = { backgroundColor: "#f6f8fa", fontFamily: "Inter, Arial, sans-serif" };
const container = { padding: "32px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "22px", fontWeight: 600, color: "#0f172a" };
const text = { fontSize: "15px", lineHeight: "22px", color: "#1f2937" };
const textMuted = { fontSize: "13px", color: "#64748b", marginTop: "16px" };
const link = { color: "#2563eb", textDecoration: "underline" };
const summaryBox = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "16px 20px",
  margin: "16px 0",
};
const summaryLine = { fontSize: "14px", lineHeight: "22px", color: "#1f2937", margin: "4px 0" };
