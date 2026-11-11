/**
 * C1-BUGS BUG-5 — phone normalisation for person dedup.
 *
 * Before: `normalisePhone` kept digits only, so "+91 98765 43210" became
 * "919876543210" while "9876543210" stayed "9876543210" — the same person
 * submitted once with and once without the country code became two people.
 *
 * Now every dedup path normalises to E.164 ("+<country code><national
 * number>") using, in order: an explicit international prefix on the input
 * ("+" or "00"), else the PERSON's country, else the TENANT's default country
 * (`tenants.settings.defaultCountry`, ISO-3166 alpha-2). There is NO platform
 * default country: with neither, a bare national number cannot be placed and
 * falls back to the legacy digits-only form.
 *
 * Matching tolerates rows written before this change (digits only, with or
 * without the country code): `phoneMatchKeys` returns every stored form the
 * same number may have, and lookups match any of them.
 */

/**
 * ISO-3166 alpha-2 → ITU calling code (without "+"). Platform reference data,
 * not tenant policy. Extend as tenants in new countries come on.
 */
export const COUNTRY_CALLING_CODES: Readonly<Record<string, string>> = {
  AE: "971",
  AR: "54",
  AT: "43",
  AU: "61",
  BD: "880",
  BE: "32",
  BR: "55",
  CA: "1",
  CH: "41",
  CN: "86",
  CZ: "420",
  DE: "49",
  DK: "45",
  EG: "20",
  ES: "34",
  FI: "358",
  FR: "33",
  GB: "44",
  HK: "852",
  ID: "62",
  IE: "353",
  IL: "972",
  IN: "91",
  IT: "39",
  JP: "81",
  KE: "254",
  KR: "82",
  LK: "94",
  MX: "52",
  MY: "60",
  NG: "234",
  NL: "31",
  NO: "47",
  NP: "977",
  NZ: "64",
  PH: "63",
  PK: "92",
  PL: "48",
  PT: "351",
  QA: "974",
  RO: "40",
  SA: "966",
  SE: "46",
  SG: "65",
  TH: "66",
  TR: "90",
  US: "1",
  VN: "84",
  ZA: "27",
};

/** Calling code for an ISO alpha-2 country, or null when unknown/absent. */
export function callingCodeFor(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_CALLING_CODES[country.trim().toUpperCase()] ?? null;
}

/** Distinct calling codes, longest first (E.164 codes are prefix-free). */
const CALLING_CODES_LONGEST_FIRST: readonly string[] = [
  ...new Set(Object.values(COUNTRY_CALLING_CODES)),
].sort((a, b) => b.length - a.length);

/**
 * The tenant's default country (ISO alpha-2) from the WHOLE tenants.settings
 * jsonb — `settings.defaultCountry`. Never throws; an absent, malformed or
 * unknown code resolves to null (no platform default country).
 */
export function resolveTenantDefaultCountry(tenantSettings: unknown): string | null {
  if (!tenantSettings || typeof tenantSettings !== "object") return null;
  const raw = (tenantSettings as Record<string, unknown>).defaultCountry;
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return COUNTRY_CALLING_CODES[code] ? code : null;
}

/**
 * Normalise a phone number for storage in `persons.phone_normalised`.
 *
 *   - "+…" or "00…"              → "+" + digits (already international)
 *   - bare number + known country → "+" + calling code + national number
 *     (leading trunk zeros dropped; a number that already starts with the
 *     calling code and is longer than a plausible national number is taken
 *     as international typed without the "+")
 *   - bare number, no country     → digits only (legacy form)
 *
 * Pure. Returns "" for input with no digits.
 */
export function normalisePhone(phone: string, country?: string | null): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 0) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00") && digits.length > 4) return `+${digits.slice(2)}`;
  const cc = callingCodeFor(country);
  if (!cc) return digits;
  // Typed with the country code but without "+": e.g. "919876543210" for IN.
  // A national significant number is at most 12 digits for every listed
  // country but rarely > 10; treat "cc + ≥ 8 more digits" as international
  // only when the whole thing is too long to be national (≥ 11 digits).
  if (digits.startsWith(cc) && digits.length >= 11 && digits.length - cc.length >= 8) {
    return `+${digits}`;
  }
  const national = digits.replace(/^0+/, "");
  if (national.length === 0) return digits;
  return `+${cc}${national}`;
}

/**
 * Every stored form a normalised number may have in `persons.phone_normalised`
 * — the E.164 value plus the pre-BUG-5 digits-only forms (with and without the
 * calling code) — so a lookup matches people written before the fix. Pure.
 */
export function phoneMatchKeys(normalised: string): string[] {
  if (!normalised) return [];
  const keys = new Set<string>([normalised]);
  if (normalised.startsWith("+")) {
    const intl = normalised.slice(1);
    keys.add(intl);
    const cc = CALLING_CODES_LONGEST_FIRST.find((c) => intl.startsWith(c));
    if (cc && intl.length - cc.length >= 6) keys.add(intl.slice(cc.length));
  } else {
    // Legacy / no-country form: it may be international typed without "+".
    keys.add(`+${normalised}`);
  }
  return [...keys];
}
