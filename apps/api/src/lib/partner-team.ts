/**
 * P1.3 — the PARTNER side of team management, plus the dashboard's
 * "needs your attention" feed (partner-wireflows §3.12 and §3.2).
 *
 * The mirror image of lib/partner-admin.ts: same disciplines, opposite tier.
 * Every export takes the partnerProcedure-supplied tenant-bound db handle plus
 * the resolved (tenantId, partnerOrgId) from ctx.partner, and every statement
 * carries BOTH predicates explicitly. That is load-bearing, not belt-and-braces:
 * the partner tables carry only a tenant_isolation RLS policy, so org scoping —
 * "is this teammate mine to suspend" — exists nowhere except in these WHERE
 * clauses. Drop the partner_org_id predicate from setPartnerTeammateActive and
 * one agency can suspend another's recruiters.
 *
 * Invitation minting is deliberately NOT reimplemented here. It delegates to
 * createPartnerInvitation in partner-admin.ts, the core both tiers share, so a
 * partner-issued invitation is byte-for-byte the same artifact an internal one
 * is and redeems through the same P0.2 /accept-invite flow.
 *
 * Deliberately NOT here: password reset (P1.4), role changes on an existing
 * teammate (no ticket yet — invite carries the intended role and that is the
 * only place a role is chosen), and deletion (partner_users rows are kept;
 * active=false is the reversible, audit-friendly suspension).
 */

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  applications,
  candidateOwnershipClaims,
  partnerAssignments,
  partnerInvitations,
  partnerUsers,
  persons,
  positions,
  requisitions,
  type TenantBoundDb,
} from "@hireops/db";
import type {
  PartnerAttentionItem,
  PartnerGetAttentionFeedOutput,
  PartnerInviteTeammateInput,
  PartnerInviteTeammateOutput,
  PartnerListTeamOutput,
  PartnerSetTeammateActiveInput,
  PartnerSetTeammateActiveOutput,
  RevokePartnerInvitationOutput,
} from "@hireops/api-types";
import { createPartnerInvitation, revokePartnerInvitationForTenant } from "./partner-admin";

/**
 * The role gate for the three team procedures. FORBIDDEN with an identical
 * machine-readable message for every non-admin caller — the same posture
 * partnerGetRequisitionDetail takes for an unassigned req: the answer tells a
 * partner_user nothing except "not you".
 */
export function requirePartnerAdmin(role: string): void {
  if (role !== "partner_admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "partner_admin_only" });
  }
}

// ───────────────────────────── team reads ─────────────────────────────

/**
 * The org's own people + its live invitations, in one payload because the
 * surface is one page (partner-wireflows §3.12).
 *
 * Inactive teammates are INCLUDED: a suspended recruiter has to stay visible
 * for the admin to reactivate them, and their history (submissions, claims,
 * dedup attempts) doesn't vanish when their access does. Live invitations use
 * the identical not-consumed / not-revoked / not-expired predicate
 * getPartnerOrgDetail uses, expiry checked at runtime because the schema's
 * partial unique index cannot contain now().
 */
export async function listPartnerTeam(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
  selfPartnerUserId: string,
): Promise<PartnerListTeamOutput> {
  const memberRows = await db
    .select({
      partnerUserId: partnerUsers.id,
      fullName: partnerUsers.fullName,
      email: partnerUsers.email,
      role: partnerUsers.role,
      active: partnerUsers.active,
      lastLoginAt: partnerUsers.lastLoginAt,
    })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.tenantId, tenantId), eq(partnerUsers.partnerOrgId, partnerOrgId)))
    .orderBy(asc(partnerUsers.fullName));

  const invitationRows = await db
    .select({
      invitationId: partnerInvitations.id,
      email: partnerInvitations.email,
      intendedRole: partnerInvitations.intendedRole,
      expiresAt: partnerInvitations.expiresAt,
      createdAt: partnerInvitations.createdAt,
    })
    .from(partnerInvitations)
    .where(
      and(
        eq(partnerInvitations.tenantId, tenantId),
        eq(partnerInvitations.partnerOrgId, partnerOrgId),
        isNull(partnerInvitations.consumedAt),
        isNull(partnerInvitations.revokedAt),
        gt(partnerInvitations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(partnerInvitations.createdAt));

  return {
    members: memberRows.map((m) => ({
      partnerUserId: m.partnerUserId,
      fullName: m.fullName,
      email: m.email,
      role: m.role,
      active: m.active,
      lastLoginAt: m.lastLoginAt ? m.lastLoginAt.toISOString() : null,
      isSelf: m.partnerUserId === selfPartnerUserId,
    })),
    invitations: invitationRows.map((i) => ({
      invitationId: i.invitationId,
      email: i.email,
      intendedRole: i.intendedRole,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    })),
  };
}

// ───────────────────────────── team writes ─────────────────────────────

/**
 * Invite a recruiter into the CALLER'S OWN org. partnerOrgId comes from
 * ctx.partner, never from the wire — that is the whole difference between this
 * and the internal invitePartnerUser, and it is why the input schema has no
 * org field to tamper with.
 */
export async function invitePartnerTeammate(
  db: TenantBoundDb,
  args: {
    tenantId: string;
    partnerOrgId: string;
    companyName: string;
    input: PartnerInviteTeammateInput;
  },
): Promise<PartnerInviteTeammateOutput> {
  return createPartnerInvitation(db, {
    tenantId: args.tenantId,
    partnerOrgId: args.partnerOrgId,
    email: args.input.email,
    fullName: args.input.fullName,
    role: args.input.role,
    companyName: args.companyName,
    // NULL by schema necessity: the column FKs tenant_user_memberships and a
    // partner user has no membership row. See createPartnerInvitation's header.
    createdByMembershipId: null,
  });
}

/**
 * P1.4 — the partner-admin twin of revokePartnerInvitationForTenant. A pending
 * invitation the admin can SEE (partnerListTeam) but not kill forces a
 * mistyped address to wait out its 7-day expiry.
 *
 * The org check runs FIRST and answers the identical FORBIDDEN for
 * other-org / other-tenant / nonexistent ids (the house probe posture); only a
 * proven own-org invitation reaches the shared tenant-level core, which owns
 * the consumed/CONFLICT and already-revoked/idempotent rules so those exist
 * exactly once.
 */
export async function revokePartnerInvitationForOrg(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
  invitationId: string,
): Promise<RevokePartnerInvitationOutput> {
  const [owned] = await db
    .select({ id: partnerInvitations.id })
    .from(partnerInvitations)
    .where(
      and(
        eq(partnerInvitations.tenantId, tenantId),
        eq(partnerInvitations.partnerOrgId, partnerOrgId),
        eq(partnerInvitations.id, invitationId),
      ),
    )
    .limit(1);
  if (!owned) {
    throw new TRPCError({ code: "FORBIDDEN", message: "partner_invitation_not_in_org" });
  }
  return revokePartnerInvitationForTenant(db, tenantId, invitationId);
}

/**
 * Suspend / reactivate a teammate.
 *
 * ONE org-scoped UPDATE … RETURNING rather than a read-then-write: no row back
 * means one of three indistinguishable things — the id isn't a partner user,
 * it belongs to another org, or it belongs to another tenant — and all three
 * answer the IDENTICAL FORBIDDEN, so a partner admin cannot use this endpoint
 * to discover that some uuid is a real user somewhere else on the platform.
 * (The same reasoning releaseOwnershipClaimForTenant applies to its NOT_FOUND.)
 *
 * Self-deactivation is refused BEFORE the statement runs: partnerProcedure
 * requires active = true, so an admin who suspended themselves would lock
 * themselves — and possibly their whole org — out of the portal with no
 * partner-side way back in.
 */
export async function setPartnerTeammateActive(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
  selfPartnerUserId: string,
  input: PartnerSetTeammateActiveInput,
): Promise<PartnerSetTeammateActiveOutput> {
  if (input.partnerUserId === selfPartnerUserId && !input.active) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "cannot_deactivate_self" });
  }

  const [row] = await db
    .update(partnerUsers)
    .set({ active: input.active, updatedAt: new Date() })
    .where(
      and(
        eq(partnerUsers.tenantId, tenantId),
        eq(partnerUsers.partnerOrgId, partnerOrgId),
        eq(partnerUsers.id, input.partnerUserId),
      ),
    )
    .returning({ id: partnerUsers.id, active: partnerUsers.active });
  if (!row) {
    throw new TRPCError({ code: "FORBIDDEN", message: "partner_user_not_in_org" });
  }
  return { partnerUserId: row.id, active: row.active };
}

// ──────────────────────── attention feed (§3.2) ────────────────────────

/** How fresh an assignment has to be to count as "new to you". */
const NEW_REQ_DAYS = 7;
/** How long a submission may sit at one stage before it needs chasing. */
const STALE_STAGE_DAYS = 14;
/** How close an ownership window has to be to expiry to be worth flagging. */
const CLAIM_EXPIRY_WARN_DAYS = 14;
/** The feed is a nudge list, not a report. */
const FEED_CAP = 20;
/**
 * Rows scanned before the feed is composed. At POC volumes an org holds tens
 * of live claims; this is the guard against a pathological seed, not paging.
 */
const CLAIM_SCAN_CAP = 200;

/**
 * Stages that need no chasing: the candidate is placed or the application is
 * closed. Extends the dashboard-stats TERMINAL set with offer_accepted — a
 * signed offer that has sat still for a fortnight is a success, not a stall,
 * and it is already surfaced by the offer_stage rule.
 */
const SETTLED_STAGES = new Set([
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);

/** Stages the wireflows call out as worth celebrating / chasing to close. */
const OFFER_STAGES = new Set(["offer_drafted", "offer_accepted"]);

/** "tech_interview" → "Tech interview". */
function stageLabel(stage: string): string {
  const spaced = stage.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "12 Aug 2026" — date-only and UTC, the same choice formatExpiryDate makes in
 * partner-admin.ts and for the same reason: the minute is noise, and a
 * date-only string sidesteps the reader's timezone entirely.
 */
function fmtDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * The dashboard's "needs your attention" list (partner-wireflows §3.2).
 *
 * Deterministic rules over data the partner can already see — there is no
 * scoring, no AI and no stored feed table, so the list is reproducible from the
 * database at any instant and cannot drift out of sync with the surfaces it
 * links to. Available to BOTH partner roles: a recruiter needs their own
 * nudges, and every rule is org-scoped anyway.
 *
 * §6.3 fence, restated where it is enforced: every title and detail is built
 * from a requisition title, a pipeline stage, a date and the candidate's own
 * name. No recruiter or hiring-manager identity, no rejection reason, no score,
 * no hint that another partner exists.
 */
export async function getPartnerAttentionFeed(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<PartnerGetAttentionFeedOutput> {
  const now = new Date();

  // (1) Reqs opened to this org in the last week. Only ACTIVE assignments —
  //     an assignment ended two days after it began is not an invitation to
  //     source against it.
  const newReqRows = await db
    .select({
      requisitionId: partnerAssignments.requisitionId,
      title: positions.title,
      assignedAt: partnerAssignments.assignedAt,
    })
    .from(partnerAssignments)
    .innerJoin(
      requisitions,
      and(
        eq(requisitions.tenantId, partnerAssignments.tenantId),
        eq(requisitions.id, partnerAssignments.requisitionId),
      ),
    )
    .innerJoin(
      positions,
      and(eq(positions.tenantId, requisitions.tenantId), eq(positions.id, requisitions.positionId)),
    )
    .where(
      and(
        eq(partnerAssignments.tenantId, tenantId),
        eq(partnerAssignments.partnerOrgId, partnerOrgId),
        eq(partnerAssignments.status, "active"),
        gt(partnerAssignments.assignedAt, sql`now() - make_interval(days => ${NEW_REQ_DAYS})`),
      ),
    )
    .orderBy(desc(partnerAssignments.assignedAt))
    .limit(FEED_CAP);

  // (2)(3)(4) all read the org's ACTIVE ownership claims with their claiming
  //     application — one query, three rules, so the three can never disagree
  //     about which submissions are the caller's. The application join is LEFT:
  //     a claim without one (the speculative path the schema allows) still
  //     counts for claim_expiring.
  const claimRows = await db
    .select({
      claimId: candidateOwnershipClaims.id,
      candidateName: persons.fullName,
      expiresAt: candidateOwnershipClaims.expiresAt,
      stage: applications.currentStage,
      stageEnteredAt: applications.stageEnteredAt,
      requisitionTitle: positions.title,
    })
    .from(candidateOwnershipClaims)
    .leftJoin(
      persons,
      and(
        eq(persons.tenantId, candidateOwnershipClaims.tenantId),
        eq(persons.id, candidateOwnershipClaims.personId),
      ),
    )
    .leftJoin(
      applications,
      and(
        eq(applications.tenantId, candidateOwnershipClaims.tenantId),
        eq(applications.id, candidateOwnershipClaims.claimedViaApplicationId),
      ),
    )
    .leftJoin(
      requisitions,
      and(
        eq(requisitions.tenantId, applications.tenantId),
        eq(requisitions.id, applications.requisitionId),
      ),
    )
    .leftJoin(
      positions,
      and(eq(positions.tenantId, requisitions.tenantId), eq(positions.id, requisitions.positionId)),
    )
    .where(
      and(
        eq(candidateOwnershipClaims.tenantId, tenantId),
        eq(candidateOwnershipClaims.partnerOrgId, partnerOrgId),
        eq(candidateOwnershipClaims.status, "active"),
      ),
    )
    .orderBy(desc(candidateOwnershipClaims.claimedAt))
    .limit(CLAIM_SCAN_CAP);

  const items: PartnerAttentionItem[] = [];

  for (const r of newReqRows) {
    items.push({
      kind: "new_req",
      title: `New req: ${r.title}`,
      detail: `Opened to your organisation on ${fmtDate(r.assignedAt)}.`,
      href: `/reqs/${r.requisitionId}`,
      occurredAt: r.assignedAt.toISOString(),
    });
  }

  for (const r of claimRows) {
    const who = r.candidateName ?? "A candidate";
    const forRole = r.requisitionTitle ? ` for ${r.requisitionTitle}` : "";

    if (r.stage && r.stageEnteredAt) {
      const daysAtStage = wholeDaysBetween(r.stageEnteredAt, now);

      if (!SETTLED_STAGES.has(r.stage) && daysAtStage >= STALE_STAGE_DAYS) {
        items.push({
          kind: "stale_submission",
          title: `${who} has been at ${stageLabel(r.stage).toLowerCase()} for ${daysAtStage} days`,
          detail: `Entered that stage on ${fmtDate(r.stageEnteredAt)}${forRole}.`,
          href: `/submissions/${r.claimId}`,
          occurredAt: r.stageEnteredAt.toISOString(),
        });
      }

      if (OFFER_STAGES.has(r.stage)) {
        items.push({
          kind: "offer_stage",
          title: `${who} is at ${stageLabel(r.stage).toLowerCase()}`,
          detail: `Reached that stage on ${fmtDate(r.stageEnteredAt)}${forRole}.`,
          href: `/submissions/${r.claimId}`,
          occurredAt: r.stageEnteredAt.toISOString(),
        });
      }
    }

    // Expiry is the date the item is ABOUT, so it is the item's occurredAt —
    // which also sorts the soonest-to-lapse windows to the top of the feed.
    const daysToExpiry = wholeDaysBetween(now, r.expiresAt);
    if (daysToExpiry <= CLAIM_EXPIRY_WARN_DAYS) {
      items.push({
        kind: "claim_expiring",
        title: `Your ownership of ${who} expires in ${daysToExpiry} days`,
        detail: `The exclusivity window closes on ${fmtDate(r.expiresAt)}${forRole}.`,
        href: `/submissions/${r.claimId}`,
        occurredAt: r.expiresAt.toISOString(),
      });
    }
  }

  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return { items: items.slice(0, FEED_CAP) };
}
