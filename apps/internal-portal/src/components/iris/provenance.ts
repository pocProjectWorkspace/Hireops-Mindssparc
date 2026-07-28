/**
 * Iris provenance consumption (IRIS-A2) — PURE helpers behind the
 * `✨ AI-assisted` pill. No React / no DOM so the honesty predicate unit tests
 * cleanly.
 *
 * HONESTY: the pill is persisted-and-consumed. It shows ONLY for an entity that
 * carries an Iris provenance row (created via irisExecute); a human-made entity
 * has no row and never shows the pill. `hasIrisProvenance` is exactly that flip.
 */

import type { IrisProvenanceRow } from "@hireops/api-types";

/**
 * Index provenance rows by entityId. The API already collapses to one row per
 * entity (latest), so first-seen wins here defensively.
 */
export function indexProvenance(rows: IrisProvenanceRow[]): Map<string, IrisProvenanceRow> {
  const map = new Map<string, IrisProvenanceRow>();
  for (const row of rows) {
    if (!map.has(row.entityId)) map.set(row.entityId, row);
  }
  return map;
}

/**
 * The honesty predicate: does this entity carry an Iris provenance row? True →
 * show the pill; false (no rows, or none for this id) → never show it.
 */
export function hasIrisProvenance(
  rows: IrisProvenanceRow[] | undefined,
  entityId: string,
): boolean {
  if (!rows) return false;
  return rows.some((row) => row.entityId === entityId);
}

/**
 * A relative label for recent times, falling back to an absolute date. Pure —
 * `now` is injectable so it tests without wall-clock flake.
 */
export function formatRelativeOrAbs(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

/** The pill's tooltip: who confirmed the Iris draft, and when. */
export function provenanceTooltip(row: IrisProvenanceRow, now: number = Date.now()): string {
  const who = row.confirmedByLabel?.trim() || "a teammate";
  return `Drafted by Iris · approved by ${who} · ${formatRelativeOrAbs(row.createdAt, now)}`;
}
