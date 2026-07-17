/**
 * Deterministic PII redaction for prompt text (CONF-01).
 *
 * A pure, dependency-free function that replaces emails, phone numbers and
 * URLs with stable `[redacted-*]` tokens before candidate-derived text
 * leaves the process. Governed by the per-tenant `piiMasking` toggle in
 * `aiSettings`; applied at the scoring + agent-draft call sites.
 *
 * Two properties the callers rely on and the unit tests pin:
 *  - Deterministic: same input → same output, no randomness, no salting.
 *  - Idempotent: masking already-masked text is a no-op. The replacement
 *    tokens contain no `@`, no URL scheme, and no digits, so no pattern can
 *    re-match them on a second pass.
 *
 * Ordering matters. Emails are redacted first (so a phone pass can't eat the
 * digits inside an email), then URLs (so the phone pass can't eat digits
 * inside a path), then phone numbers last. A phone match requires ≥7 digits
 * so that years ("2026"), weights ("0.80") and short counts ("5 years")
 * survive untouched — only real phone numbers are redacted.
 */

export const REDACTED_EMAIL = "[redacted-email]";
export const REDACTED_PHONE = "[redacted-phone]";
export const REDACTED_URL = "[redacted-url]";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
/**
 * A run of digits and common phone separators, bookended by digits. The
 * replacer additionally requires ≥7 digits total so short numeric tokens
 * are not mistaken for phone numbers.
 */
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{5,}\d/g;
const MIN_PHONE_DIGITS = 7;

/**
 * Redact emails, URLs and phone numbers in `input`. Non-string / empty
 * input is returned unchanged. Safe to call on text with no PII (returns it
 * verbatim) and safe to call twice (idempotent).
 */
export function maskPii(input: string): string {
  if (!input) return input;
  let out = input.replace(EMAIL_RE, REDACTED_EMAIL);
  out = out.replace(URL_RE, REDACTED_URL);
  out = out.replace(PHONE_CANDIDATE_RE, (match) => {
    const digitCount = (match.match(/\d/g) ?? []).length;
    return digitCount >= MIN_PHONE_DIGITS ? REDACTED_PHONE : match;
  });
  return out;
}

/**
 * Convenience: mask only when `enabled`. Keeps call sites a single
 * expression (`maskPiiIf(settings.piiMasking, prompt)`).
 */
export function maskPiiIf(enabled: boolean, input: string): string {
  return enabled ? maskPii(input) : input;
}
