/**
 * PC-5 — triage page sizes. A plain (non-"use client") module so the server
 * page and the client lists share the same numbers.
 */

/** Hot Zone (SLA breaches) page size — was a fixed cap of 20, now paged. */
export const HOT_ZONE_PAGE = 20;

/** Momentum (fresh applications) page size — was a fixed cap of 50, now paged. */
export const MOMENTUM_PAGE = 50;
