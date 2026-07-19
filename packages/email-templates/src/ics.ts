import type { EmailAttachment } from "@hireops/notifications";

/**
 * Honest `.ics` calendar attachment (A13 slice, RECR-01). Builds a REAL,
 * RFC-5545 VEVENT deterministically from the interview facts already carried on
 * the invitation email — no third-party calendar API, no fake Meet link, no
 * two-way sync. The candidate's mail client offers a genuine "add to calendar";
 * the recruiter-side badge reads "invite sent (.ics)", never "synced".
 */

export interface BuildInterviewIcsInput {
  /** Stable id → the VEVENT UID (so a re-send updates the same event). */
  interviewId: string;
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  /** ISO-8601 start instant. When absent/invalid, no .ics is produced. */
  interviewStartIso: string;
  durationMinutes: number;
  /** "Video" | "On-site" | "Phone". */
  modeLabel: string;
  /** Join URL, or empty string. */
  meetingUrl: string;
  /** Candidate confirm link — included in the description. */
  confirmUrl: string;
}

/** RFC-5545 UTC timestamp: YYYYMMDDTHHMMSSZ. */
function toIcsUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Escape a TEXT value per RFC-5545 §3.3.11 (backslash, comma, semicolon, newline). */
function escapeText(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold a content line to <=75 octets per RFC-5545 §3.1 (space-prefixed continuation). */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const chunks: string[] = [];
  let rest = line;
  chunks.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length > 0) {
    chunks.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  return chunks.join("\r\n");
}

/**
 * Build the interview .ics attachment, or null when there is no valid start
 * instant (a TBC interview gets no calendar file — we don't invent a time).
 */
export function buildInterviewIcs(input: BuildInterviewIcsInput): EmailAttachment | null {
  const start = new Date(input.interviewStartIso);
  if (Number.isNaN(start.getTime())) return null;
  const durationMs = Math.max(1, input.durationMinutes) * 60_000;
  const end = new Date(start.getTime() + durationMs);

  const summary = `${input.roundName} — ${input.positionTitle} at ${input.companyName}`;
  const descriptionParts = [
    `Interview: ${input.roundName} for ${input.positionTitle}`,
    `Candidate: ${input.candidateName}`,
    `Format: ${input.modeLabel} · ${input.durationMinutes} minutes`,
  ];
  if (input.meetingUrl) descriptionParts.push(`Join: ${input.meetingUrl}`);
  if (input.confirmUrl) descriptionParts.push(`Confirm attendance: ${input.confirmUrl}`);
  const location = input.meetingUrl || input.modeLabel;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HireOps//Interview Scheduling//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:interview-${input.interviewId}@hireops`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(descriptionParts.join("\n"))}`,
    `LOCATION:${escapeText(location)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const ics = lines.map(foldLine).join("\r\n") + "\r\n";
  return {
    filename: "interview.ics",
    content: Buffer.from(ics, "utf8").toString("base64"),
    contentType: "text/calendar",
  };
}
