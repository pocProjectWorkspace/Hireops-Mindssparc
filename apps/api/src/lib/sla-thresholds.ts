/**
 * Re-export shim — kept so existing call sites
 * (`import { SLA_THRESHOLDS_HOURS } from "../lib/sla-thresholds"`) don't
 * need a sweeping rename. The canonical map lives in
 * `@hireops/sla-thresholds`; the workers package consumes it too. Module
 * 4 extracted it after a third consumer (the offers code path) made the
 * duplication painful.
 */

export {
  SLA_THRESHOLDS_HOURS,
  SLA_BREACH_STAGES,
  thresholdHoursFor,
} from "@hireops/sla-thresholds";
