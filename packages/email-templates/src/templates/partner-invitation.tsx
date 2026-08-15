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

export interface PartnerInvitationProps {
  /** The invitee's name, as the inviting staff member typed it. */
  inviteeName: string;
  /** The partner org they are being invited into. */
  partnerOrgName: string;
  /** The tenant doing the inviting (e.g. "Kyndryl"). */
  companyName: string;
  /** Absolute URL to the partner portal's accept-invite route. */
  acceptUrl: string;
  /** Human-readable expiry, e.g. "20 August 2026". */
  expiresAtFormatted: string;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * Sent when internal staff (admin / hr_ops) invite a partner user into a
 * partner org (P0.1A). One paragraph of context + a single button to the
 * partner portal's /accept-invite/[token] route, where the invitee sets a
 * password and their partner_users row is created.
 *
 * The link carries a raw 32-byte token; only its sha256 is persisted
 * (partner_invitations.token_hash), so the URL exists in this email and in the
 * mutation's response and nowhere else. It is single-use and expires.
 *
 * Structure is deliberately identical to candidate-account-activation: same
 * container/heading/button styles, same slot vocabulary, so the tenant copy
 * editor treats the two the same way.
 */
export function PartnerInvitation({
  inviteeName,
  partnerOrgName,
  companyName,
  acceptUrl,
  expiresAtFormatted,
  slots,
}: PartnerInvitationProps) {
  const tok = { inviteeName, partnerOrgName, companyName, expiresAtFormatted };
  return (
    <Html>
      <Head />
      <Preview>{`${companyName} has invited ${partnerOrgName} to their partner portal`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>You&rsquo;ve been invited</>)}
          </Heading>
          <Section>
            <Text style={text}>{resolveSlot(slots?.greeting, tok, <>Hi {inviteeName},</>)}</Text>
            <Text style={text}>
              {resolveSlot(
                slots?.body,
                tok,
                <>
                  <strong>{companyName}</strong> has invited you to join the{" "}
                  <strong>{partnerOrgName}</strong> account on their partner portal, where you can
                  see the requisitions they&rsquo;ve opened to you and submit candidates against
                  them. Set a password to activate your access.
                </>,
              )}
            </Text>
            <Section style={{ textAlign: "center", margin: "28px 0" }}>
              <Link href={acceptUrl} style={button}>
                {resolveSlot(slots?.ctaLabel, tok, <>Accept the invitation</>)}
              </Link>
            </Section>
            <Text style={textMuted}>
              {resolveSlot(
                slots?.expiryNote,
                tok,
                <>
                  This link is private to you, can be used once, and expires on {expiresAtFormatted}
                  . If it expires, ask your {companyName} contact to send a new one.
                </>,
              )}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(
                slots?.privateNote,
                tok,
                <>
                  If you weren&rsquo;t expecting this invitation, you can safely ignore this email —
                  no account is created until the link is used.
                </>,
              )}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(slots?.signOff, tok, <>— The {companyName} sourcing team</>)}
            </Text>
            <Text style={textPlainFallback}>
              {resolveSlot(
                slots?.plainLinkNote,
                tok,
                <>If the button doesn&rsquo;t work, paste this link into your browser:</>,
              )}{" "}
              {acceptUrl}
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
const textPlainFallback = {
  fontSize: "12px",
  color: "#94a3b8",
  marginTop: "20px",
  wordBreak: "break-all" as const,
};
const button = {
  backgroundColor: "#4f46e5",
  color: "#ffffff",
  padding: "12px 28px",
  borderRadius: "6px",
  textDecoration: "none",
  fontWeight: 600,
  display: "inline-block",
};
