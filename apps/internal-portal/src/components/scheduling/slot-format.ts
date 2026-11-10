/**
 * PC-8 / PC-9 — time display for scheduling surfaces.
 *
 * Everything is stored and transported as UTC instants. These helpers render
 * them in the VIEWER'S OWN browser time zone (an `undefined` timeZone in Intl
 * means "this browser's zone"), and name that zone so nobody has to guess.
 */

/** The viewer's IANA zone, e.g. "Asia/Kolkata" or "America/New_York". */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "Tue 17 Nov, 10:00" in the viewer's zone. */
export function formatSlot(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "10:00–10:45" in the viewer's zone. */
export function formatSlotRange(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return startIso;
  const day = s.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${s.toLocaleTimeString(undefined, opts)}–${e.toLocaleTimeString(undefined, opts)}`;
}

/** The local calendar day of an instant, for grouping slots by day. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** Group slots by the viewer's local day, preserving order. */
export function groupByLocalDay<T extends { start: string }>(slots: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const s of slots) {
    const k = localDayKey(s.start);
    const list = map.get(k) ?? [];
    list.push(s);
    map.set(k, list);
  }
  return [...map.entries()];
}

/** A datetime-local input value (viewer's zone) for an ISO instant. */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
