/**
 * Client-side CSV export — the house pattern, extracted from the admin
 * audit console (AD10) so /reports can reuse it verbatim (R0.4).
 *
 * There is deliberately NO server-side CSV endpoint: every export is built
 * in the browser from rows the surface has ALREADY fetched. That keeps one
 * honest contract — the file contains exactly what the screen is showing,
 * including any server-side cap. A capped export says so on screen, next to
 * the button; nothing is appended to the file itself (no trailing comment,
 * no "exported at" line), because a comment row breaks every spreadsheet
 * import it lands in.
 *
 * Line endings are CRLF and there is no trailing newline — RFC 4180, and
 * byte-identical to what the audit console shipped.
 */

/** RFC-4180 field quoting: wrap in quotes, double any embedded quote. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Header row + body rows → a CSV document. Callers stringify their own
 * cells (a number's presentation is the report's decision, not the CSV
 * layer's); every cell, header included, goes through `csvField`.
 */
export function buildCsv(headers: readonly string[], rows: readonly string[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n");
}

/** Blob + synthetic anchor click. No-ops during SSR. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
