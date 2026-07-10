/**
 * Presentation helpers for the approval queue. Pure functions — kept out
 * of the components so they can be unit-tested without a DOM.
 */

/** "3 minutes ago", "2 hours ago", "just now" from an ISO timestamp. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * cost_micros (bigint-as-string, 1 USD = 1,000,000 micros) → a compact
 * USD string. Sub-cent costs are the norm for a single draft, so show
 * enough precision to be non-zero.
 */
export function formatCostMicros(micros: string): string {
  const n = Number(micros);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const usd = n / 1_000_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * The follow-up / Q&A agents' draft_message output has a `draft_text`
 * (+ subject + recipient) shape. Detect it so the detail panel can render
 * an editable message instead of a raw JSON blob. Scheduling payloads
 * (proposed_slots, etc.) fall through to the JSON view until those agents
 * ship a UI.
 */
export interface DraftPayload {
  draft_text: string;
  subject?: string;
  candidate_name?: string;
  candidate_email?: string;
  position_title?: string;
  company_name?: string;
}

export function asDraftPayload(payload: Record<string, unknown>): DraftPayload | null {
  const draft = payload.draft_text;
  if (typeof draft !== "string" || draft.trim().length === 0) return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    draft_text: draft,
    subject: str(payload.subject),
    candidate_name: str(payload.candidate_name),
    candidate_email: str(payload.candidate_email),
    position_title: str(payload.position_title),
    company_name: str(payload.company_name),
  };
}

/** Best-effort candidate label for a queue card, from the proposed payload. */
export function candidateLabel(payload: Record<string, unknown>): string | null {
  const name = payload.candidate_name;
  if (typeof name === "string" && name.trim()) return name;
  const email = payload.candidate_email;
  if (typeof email === "string" && email.trim()) return email;
  return null;
}
