/**
 * Shared persona-surface patterns (HRHEAD-01). These are the reuse contract for
 * every later persona pass — the dashboard/approvals gestalt distilled into
 * composable pieces on OUR slate+indigo tokens. Promote stable ones to
 * @hireops/ui when a second app needs them.
 */
export { PageHeader } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";
export { HeroStatCard } from "./HeroStatCard";
export type { HeroStatCardProps } from "./HeroStatCard";
export { StageFunnel } from "./StageFunnel";
export type { StageFunnelStage } from "./StageFunnel";
export { ActionTriad } from "./ActionTriad";
export type { ActionTriadProps } from "./ActionTriad";
export { AlertCard } from "./AlertCard";
export type { AlertCardProps, AlertSeverity } from "./AlertCard";
export {
  PriorityChip,
  OutcomeChip,
  RecommendationChip,
  HrRecChip,
  StageChip,
  DocStatusChip,
  DocOverallChip,
} from "./Chips";
export {
  CheckIcon,
  UndoIcon,
  XIcon,
  ChevronRightIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  InboxIcon,
  ShieldIcon,
} from "./icons";
