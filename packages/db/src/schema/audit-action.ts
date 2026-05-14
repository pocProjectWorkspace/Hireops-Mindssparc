import { pgEnum } from "drizzle-orm/pg-core";

/**
 * The three DML verbs that audit_record_change() captures.
 *
 * Business-level actions ("approved", "rejected", "offer_sent") belong on
 * domain tables or state-transition tables, not here. audit_logs records
 * data changes; workflow events have their own structures.
 */
export const auditActionEnum = pgEnum("audit_action", ["insert", "update", "delete"]);
export type AuditAction = (typeof auditActionEnum.enumValues)[number];
