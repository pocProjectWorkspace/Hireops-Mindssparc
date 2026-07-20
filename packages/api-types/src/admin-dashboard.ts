/**
 * Admin persona dashboard contract (AD-01). Feeds the bespoke admin landing
 * surface beyond the base getMyDashboard payload.
 *
 * EVERYTHING here is DETERMINISTIC — real, tenant-scoped counts computed off
 * live tables (requisitions, tenant_user_memberships, automation_agents,
 * audit_logs). There is NO demographic inference anywhere: the prototype's
 * "Bias Alert: gender skew 72% male" notification is deliberately absent (EU
 * AI Act posture — a selling point, not a gap). No invented metrics, no
 * probability tiles, no "AI Report Scheduler" placeholder.
 */

import { z } from "zod";

/**
 * The four real governance tiles. Each is a plain integer count over a
 * tenant-scoped table; `href` deep-links to the admin surface that owns it.
 */
export const adminDashboardTileSchema = z.object({
  openRequisitions: z.number().int(),
  activeUsers: z.number().int(),
  activeWorkflows: z.number().int(),
  auditEvents7d: z.number().int(),
});
export type AdminDashboardTiles = z.infer<typeof adminDashboardTileSchema>;

export const getAdminDashboardExtrasOutputSchema = z.object({
  tiles: adminDashboardTileSchema,
});
export type GetAdminDashboardExtrasOutput = z.infer<typeof getAdminDashboardExtrasOutputSchema>;
