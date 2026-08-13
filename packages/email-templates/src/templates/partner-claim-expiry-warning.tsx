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

export interface PartnerClaimExpiryWarningProps {
  /** The partner user who made the claim (the submitting user). */
  partnerContactName: string;
  /** The candidate the ownership claim covers. */
  candidateName: string;
  /** The hiring organisation — the tenant's display name (e.g. "Kyndryl"). */
  companyName: string;
  /** Human-readable claim expiry date, e.g. "20 August 2026". */
  expiresAtFormatted: string;
  /** T1.4 — optional tenant copy overrides. */
  slots?: SlotOverrides;
}

/**
 * P0.4 — "your exclusivity on this candidate lapses soon".
 *
 * Sent by the worker (warnExpiringOwnershipClaims, in the ownership-claim sweep
 * job) once per claim, seven days out. The claim itself is the 90-day
 * exclusivity window candidate_ownership_claims describes: while it is active
 * no other partner can submit that person; once it expires the person is free
 * for anyone to submit again, including a different agency.
 *
 * This email exists because that lapse is otherwise silent — the sweep flips
 * the status and the partner only discovers it when a resubmission is refused.
 *
 * PRIVACY (requirements.md §6.3): candidate name + date only. It deliberately
 * does NOT say what stage the candidate reached, whether anyone else has
 * shown interest, or that other partners exist.
 */
export function PartnerClaimExpiryWarning({
  partnerContactName,
  candidateName,
  companyName,
  expiresAtFormatted,
  slots,
}: PartnerClaimExpiryWarningProps) {
  const tok = { partnerContactName, candidateName, companyName, expiresAtFormatted };
  return (
    <Html>
      <Head />
      <Preview>{`Your claim on ${candidateName} expires on ${expiresAtFormatted}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>
            {resolveSlot(slots?.heading, tok, <>Your candidate claim expires soon</>)}
          </Heading>
          <Section>
            <Text style={text}>
              {resolveSlot(slots?.greeting, tok, <>Hi {partnerContactName},</>)}
            </Text>
            <Text style={text}>
              {resolveSlot(
                slots?.body,
                tok,
                <>
                  Your ownership claim on <strong>{candidateName}</strong> with{" "}
                  <strong>{companyName}</strong> expires on <strong>{expiresAtFormatted}</strong>.
                </>,
              )}
            </Text>
            <Text style={text}>
              {resolveSlot(
                slots?.meaningNote,
                tok,
                <>
                  Until then the candidate is attributed to you exclusively. After that date the
                  exclusivity lapses: the same candidate may be submitted again by another partner,
                  and attribution would follow that submission instead.
                </>,
              )}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(
                slots?.contactNote,
                tok,
                <>
                  If you believe this candidate should stay attributed to you, speak to your{" "}
                  {companyName} contact before the expiry date.
                </>,
              )}
            </Text>
            <Text style={textMuted}>
              {resolveSlot(slots?.signOff, tok, <>— The {companyName} sourcing team</>)}
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
