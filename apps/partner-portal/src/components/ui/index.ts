/**
 * Portal-local UI primitives, copied from apps/internal-portal (DESIGN-01).
 * Kept app-local by the same convention the internal portal follows —
 * promoting the stable ones to @hireops/ui is a later refactor. The partner
 * portal reuses the exact same primitives so the two surfaces read as one
 * design system.
 */
export { cn } from "./cn";
export { Button } from "./Button";
export type { ButtonProps, PortalButtonVariant, PortalButtonSize } from "./Button";
export { Card } from "./Card";
export type { CardProps } from "./Card";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";
export { StatTile } from "./StatTile";
export type { StatTileProps, StatTileTone } from "./StatTile";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { Skeleton, SkeletonTiles, SkeletonRows } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";
