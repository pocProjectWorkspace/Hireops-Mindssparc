import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Shape of a knockout question on a requisition. Determines how
 * threshold_value (jsonb) is interpreted at evaluation time.
 *
 *   boolean       — threshold_value = { required: true } (must be true)
 *   numeric_min   — threshold_value = { min: 5 }         (value must be >= min)
 *   numeric_max   — threshold_value = { max: 30 }        (value must be <= max)
 *   enum          — threshold_value = { allowed: [...] } (value must be in set)
 */

export const KNOCKOUT_TYPES = ["boolean", "numeric_min", "numeric_max", "enum"] as const;

export type KnockoutType = (typeof KNOCKOUT_TYPES)[number];

export const knockoutTypeEnum = pgEnum("knockout_type", KNOCKOUT_TYPES);
