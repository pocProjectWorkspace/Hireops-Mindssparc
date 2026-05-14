/**
 * Position location type. Defined here (not on positions.ts) so other tables
 * can FK or reuse the enum value list without a circular import on positions.
 */

import { pgEnum } from "drizzle-orm/pg-core";

export const LOCATION_TYPES = ["remote", "hybrid", "onsite", "multi"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const locationTypeEnum = pgEnum("location_type", LOCATION_TYPES);
