import type { BadgeTone } from "@/components/ui";

/**
 * Formatting shared by every surface that renders a requisition to a partner
 * — the dashboard's card grid, /reqs, and /reqs/<id>. Extracted from
 * PartnerDashboard when the req pages landed (P1.1-UI) so the three surfaces
 * can never drift into showing the same status or date two different ways.
 */

/** A date the partner can read, or an em dash when the platform has none. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const REQ_STATUS_TONE: Record<string, BadgeTone> = {
  posted: "success",
  approved: "info",
  on_hold: "warning",
  filled: "neutral",
  closed: "neutral",
  cancelled: "error",
  draft: "neutral",
  pending_approval: "info",
};

/** Badge tone for a requisition status; unknown statuses read as neutral. */
export function reqStatusTone(status: string): BadgeTone {
  return REQ_STATUS_TONE[status] ?? "neutral";
}

/** `on_hold` → `on hold`. The Badge applies the capitalisation. */
export function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * The comp band as a partner should read it. The API hands over the raw
 * numeric strings postgres returns plus the currency, precisely so this can
 * format without a lossy parse — and so "no band on the position" stays an
 * honest "Not disclosed" rather than a fabricated zero.
 */
export function fmtCompBand(
  min: string | null,
  max: string | null,
  currency: string | null,
): string {
  const lo = fmtMoney(min, currency);
  const hi = fmtMoney(max, currency);
  if (lo && hi) return lo === hi ? lo : `${lo} – ${hi}`;
  if (lo) return `From ${lo}`;
  if (hi) return `Up to ${hi}`;
  return "Not disclosed";
}

function fmtMoney(value: string | null, currency: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const code = currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  if (code) {
    try {
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
      }).format(n);
    } catch {
      // Unknown ISO code — fall through to the plain-number rendering below.
    }
  }
  const plain = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(n);
  return currency ? `${plain} ${currency}` : plain;
}
