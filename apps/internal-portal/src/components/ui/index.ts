/**
 * Portal-local UI primitives (DESIGN-01). Small, typed, className-composable.
 * These exist so phases 2–3 consume them across the recruiter/admin surfaces;
 * promoting the stable ones to @hireops/ui is a later refactor.
 */
export { cn } from "./cn";
export { Button } from "./Button";
export type { ButtonProps, PortalButtonVariant, PortalButtonSize } from "./Button";
export { Card } from "./Card";
export type { CardProps } from "./Card";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";
export { Avatar } from "./Avatar";
export type { AvatarProps, AvatarSize } from "./Avatar";
export { ScoreMeter } from "./ScoreMeter";
export type { ScoreMeterProps } from "./ScoreMeter";
export { StatTile } from "./StatTile";
export type { StatTileProps, StatTileTone } from "./StatTile";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { DataBar } from "./DataBar";
export type { DataBarProps } from "./DataBar";
export { Skeleton, SkeletonTiles, SkeletonRows } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";
export { TableShell, Thead, Th, Tbody, Tr, Td } from "./TableShell";
