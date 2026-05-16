import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Partner-side RBAC roles. Parallel to (but separate from) tenant_role.
 *
 * - partner_admin: manages users for their partner_org, sees all reqs
 * - partner_user:  submits candidates, sees assigned reqs only
 */
export const partnerUserRoleEnum = pgEnum("partner_user_role", ["partner_admin", "partner_user"]);
export type PartnerUserRole = (typeof partnerUserRoleEnum.enumValues)[number];
