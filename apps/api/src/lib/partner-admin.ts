/**
 * P0.1A — internal partner administration (admin / hr_ops).
 *
 * The INTERNAL-STAFF half of the partner lifecycle: create partner orgs,
 * invite partner users, open/close requisitions to a partner. Until this
 * module existed the only way to get partner_orgs / partner_users /
 * partner_assignments rows was packages/db/src/scripts/seed-partner-demo.ts.
 *
 * Shape mirrors apps/api/src/lib/governance.ts: every export is a function
 * over a caller-supplied tenant-bound db handle (protectedProcedure's
 * withTenantContext tx) plus an explicit tenantId, so the router procedures
 * stay thin and this file is directly unit-testable. Two disciplines are
 * load-bearing here:
 *
 *   1. EXPLICIT tenant_id predicate on every statement, on top of the
 *      tenant_isolation RLS policy the tx already applies (house rule). The
 *      partner tables carry ONLY a tenant-level policy, so anything narrower
 *      than the tenant — org scoping, "is this req ours" — has to be an
 *      explicit predicate, never an assumption about RLS.
 *   2. Invitation tokens follow the discipline the partner_invitations schema
 *      header spells out: 32 random bytes → base64url → the RAW token goes in
 *      the email link and the mutation's response, only its SHA-256 is
 *      persisted. Nothing here logs the raw token.
 *
 * Deliberately NOT here: the accept/redeem flow (a later ticket owns
 * /accept-invite, consuming the token and minting the partner_users row) and
 * anything the partner portal itself calls — those are partnerProcedure.
 *
 * P0.3 added the ownership-claim lifecycle's internal half to this file (the
 * claims read + the manual release), because it is the same caller, the same
 * role gate and the same org-detail surface. The time-driven half deliberately
 * is NOT here: flipping past-expiry claims to 'expired' is a cross-tenant batch
 * and lives in the worker (apps/workers/src/jobs/ownership-claim-sweep.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull, gt, sql } from "drizzle-orm";
import {
  partnerOrgs,
  partnerUsers,
  partnerInvitations,
  partnerAssignments,
  candidateOwnershipClaims,
  persons,
  requisitions,
  positions,
  type TenantBoundDb,
} from "@hireops/db";
import { enqueueNotification } from "@hireops/notifications";
import type {
  CreatePartnerOrgInput,
  CreatePartnerOrgOutput,
  EndPartnerAssignmentOutput,
  GetPartnerOrgOutput,
  InvitePartnerUserInput,
  InvitePartnerUserOutput,
  ListPartnerOrgsOutput,
  PartnerOrgSummary,
  RevokePartnerInvitationOutput,
  SetPartnerOrgActiveInput,
  SetPartnerOrgActiveOutput,
  AssignRequisitionToPartnerInput,
  AssignRequisitionToPartnerOutput,
  ListPartnerOrgClaimsOutput,
  ReleaseOwnershipClaimInput,
  ReleaseOwnershipClaimOutput,
} from "@hireops/api-types";

/**
 * Invitation lifetime. The wireflows said 24h; these invitations are minted by
 * internal staff (not self-service) and are freely re-issuable from the same
 * surface, so a 7-day window is the friendlier POC default — a partner contact
 * who reads their mail on Monday still has a live link. Change here only; the
 * expiry is stored per-row, so shortening it never invalidates live rows.
 */
export const PARTNER_INVITE_EXPIRY_DAYS = 7;

/** 32 bytes, base64url — ~43 chars. Never persisted, never logged. */
function mintInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex of the raw token — the ONLY form that reaches the database. */
export function hashPartnerInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Partner-portal origin for the accept-invite link. Read exactly the way the
 * candidate/internal portal base is read elsewhere in the API
 * (`process.env.X ?? localhost-default`, see the offer / activation /
 * interview-confirm links) — the partner portal is a SEPARATE Next app
 * (apps/partner-portal, `next dev -p 3005`), so it needs its own variable
 * rather than reusing NEXT_PUBLIC_SITE_URL.
 */
export function partnerPortalBaseUrl(): string {
  return process.env.PARTNER_PORTAL_URL ?? "http://localhost:3005";
}

/** The absolute link the invitation email carries. */
export function partnerInviteAcceptUrl(rawToken: string): string {
  return `${partnerPortalBaseUrl()}/accept-invite/${rawToken}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * "20 August 2026" — the human expiry in the invitation email. Deliberately
 * date-only and UTC: the exact minute is noise to the reader, and a
 * date-only string sidesteps the recipient-timezone question entirely (the
 * same reason formatInterviewWhen renders an explicit UTC clock rather than
 * guessing a locale).
 */
function formatExpiryDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

/** Emails are compared and stored case-insensitively (lower-cased). */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ───────────────────────────── reads ─────────────────────────────

/**
 * The org columns + the three counts the internal list/detail need, as a
 * single row per org. The counts are correlated scalar subqueries rather than
 * three LEFT JOINs + GROUP BY: at POC scale (tens of orgs) the plan is
 * irrelevant, and this keeps each count's predicate — especially the
 * `active` / `status='active'` filters, which differ per table — readable and
 * independently correct.
 */
function orgSummaryColumns(tenantId: string) {
  return {
    partnerOrgId: partnerOrgs.id,
    name: partnerOrgs.name,
    legalEntityName: partnerOrgs.legalEntityName,
    tier: partnerOrgs.tier,
    country: partnerOrgs.country,
    primaryContactEmail: partnerOrgs.primaryContactEmail,
    primaryContactPhone: partnerOrgs.primaryContactPhone,
    active: partnerOrgs.active,
    onboardedAt: partnerOrgs.onboardedAt,
    // Raw identifiers on purpose: inside a .select() projection drizzle
    // renders Column refs unqualified, which turned these correlated
    // predicates into self-comparisons (always 0). tenantId stays a bound
    // parameter; only identifiers are literal.
    userCount: sql<number>`(
      SELECT count(*)::int FROM partner_users pu
      WHERE pu.tenant_id = ${tenantId}::uuid
        AND pu.partner_org_id = partner_orgs.id
        AND pu.active
    )`,
    activeAssignmentCount: sql<number>`(
      SELECT count(*)::int FROM partner_assignments pa
      WHERE pa.tenant_id = ${tenantId}::uuid
        AND pa.partner_org_id = partner_orgs.id
        AND pa.status = 'active'
    )`,
    activeClaimCount: sql<number>`(
      SELECT count(*)::int FROM candidate_ownership_claims coc
      WHERE coc.tenant_id = ${tenantId}::uuid
        AND coc.partner_org_id = partner_orgs.id
        AND coc.status = 'active'
    )`,
  };
}

interface OrgSummaryRow {
  partnerOrgId: string;
  name: string;
  legalEntityName: string | null;
  tier: "empanelled" | "ad_hoc";
  country: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  active: boolean;
  onboardedAt: Date | null;
  userCount: number;
  activeAssignmentCount: number;
  activeClaimCount: number;
}

function toOrgSummary(r: OrgSummaryRow): PartnerOrgSummary {
  return {
    partnerOrgId: r.partnerOrgId,
    name: r.name,
    legalEntityName: r.legalEntityName,
    tier: r.tier,
    country: r.country,
    primaryContactEmail: r.primaryContactEmail,
    primaryContactPhone: r.primaryContactPhone,
    active: r.active,
    onboardedAt: r.onboardedAt ? r.onboardedAt.toISOString() : null,
    userCount: r.userCount,
    activeAssignmentCount: r.activeAssignmentCount,
    activeClaimCount: r.activeClaimCount,
  };
}

/** Every partner org in the tenant, alphabetical, with its live counts. */
export async function listPartnerOrgsForTenant(
  db: TenantBoundDb,
  tenantId: string,
): Promise<ListPartnerOrgsOutput> {
  const rows = await db
    .select(orgSummaryColumns(tenantId))
    .from(partnerOrgs)
    .where(eq(partnerOrgs.tenantId, tenantId))
    .orderBy(asc(partnerOrgs.name));
  return { items: rows.map(toOrgSummary) };
}

/**
 * One org's full internal picture: the summary row, its portal users, its LIVE
 * invitations, and its assignment history (active AND ended — the internal
 * view is the record; the partner portal only ever sees status='active').
 * NOT_FOUND when the org isn't this tenant's.
 */
export async function getPartnerOrgDetail(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<GetPartnerOrgOutput> {
  const [orgRow] = await db
    .select(orgSummaryColumns(tenantId))
    .from(partnerOrgs)
    .where(and(eq(partnerOrgs.tenantId, tenantId), eq(partnerOrgs.id, partnerOrgId)))
    .limit(1);
  if (!orgRow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_org_not_found" });
  }

  const userRows = await db
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

  // Live invitations only: not consumed, not revoked, not expired. The
  // expires_at check has to be a runtime predicate — the schema's partial
  // unique index can't include now() (non-IMMUTABLE), as its header explains.
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

  // Same requisitions→positions join partnerListAssignedRequisitions uses, so
  // the internal and partner views can never disagree about a req's title.
  const assignmentRows = await db
    .select({
      assignmentId: partnerAssignments.id,
      requisitionId: partnerAssignments.requisitionId,
      title: positions.title,
      requisitionStatus: requisitions.status,
      status: partnerAssignments.status,
      assignedAt: partnerAssignments.assignedAt,
      endedAt: partnerAssignments.endedAt,
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
      ),
    )
    .orderBy(desc(partnerAssignments.assignedAt));

  return {
    org: toOrgSummary(orgRow),
    users: userRows.map((u) => ({
      partnerUserId: u.partnerUserId,
      fullName: u.fullName,
      email: u.email,
      role: u.role,
      active: u.active,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    })),
    pendingInvitations: invitationRows.map((i) => ({
      invitationId: i.invitationId,
      email: i.email,
      intendedRole: i.intendedRole,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    })),
    assignments: assignmentRows.map((a) => ({
      assignmentId: a.assignmentId,
      requisitionId: a.requisitionId,
      title: a.title,
      requisitionStatus: a.requisitionStatus,
      status: a.status,
      assignedAt: a.assignedAt.toISOString(),
      endedAt: a.endedAt ? a.endedAt.toISOString() : null,
    })),
  };
}

/**
 * P0.3 — one org's ownership claims, newest first, INCLUDING the non-active
 * history (released / expired / superseded). The status column is the story:
 * an expired row is how internal staff see that a window closed, and hiding it
 * would make this view disagree with the audit trail.
 *
 * Privacy posture is deliberately the partner portal's: exactly one personal
 * field, the person's display name, through the same left join
 * partnerListMySubmissions uses (nullable for the same reason — the join, not
 * the column, is what can come back empty). No email, no phone, no scores;
 * staff who need the candidate record open the candidate surface, where the
 * PII-access log applies.
 *
 * NOT_FOUND when the org isn't this tenant's — the same cross-tenant probe
 * answer getPartnerOrgDetail gives, so a wrong id tells the caller nothing.
 */
export async function listPartnerOrgClaimsForTenant(
  db: TenantBoundDb,
  tenantId: string,
  partnerOrgId: string,
): Promise<ListPartnerOrgClaimsOutput> {
  const [org] = await db
    .select({ id: partnerOrgs.id })
    .from(partnerOrgs)
    .where(and(eq(partnerOrgs.tenantId, tenantId), eq(partnerOrgs.id, partnerOrgId)))
    .limit(1);
  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_org_not_found" });
  }

  const rows = await db
    .select({
      claimId: candidateOwnershipClaims.id,
      candidateName: persons.fullName,
      status: candidateOwnershipClaims.status,
      claimedAt: candidateOwnershipClaims.claimedAt,
      expiresAt: candidateOwnershipClaims.expiresAt,
      releasedAt: candidateOwnershipClaims.releasedAt,
      releasedReason: candidateOwnershipClaims.releasedReason,
    })
    .from(candidateOwnershipClaims)
    .leftJoin(
      persons,
      and(
        eq(persons.tenantId, candidateOwnershipClaims.tenantId),
        eq(persons.id, candidateOwnershipClaims.personId),
      ),
    )
    .where(
      and(
        eq(candidateOwnershipClaims.tenantId, tenantId),
        eq(candidateOwnershipClaims.partnerOrgId, partnerOrgId),
      ),
    )
    .orderBy(desc(candidateOwnershipClaims.claimedAt));

  return {
    items: rows.map((r) => ({
      claimId: r.claimId,
      candidateName: r.candidateName ?? null,
      status: r.status,
      claimedAt: r.claimedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
      releasedReason: r.releasedReason,
    })),
  };
}

// ─────────────────────────── org writes ───────────────────────────

/**
 * Create an ACTIVE partner org, onboarded now. There is deliberately no
 * duplicate-name guard: partner_orgs has no unique on (tenant, name), two
 * legally distinct entities can share a trading name, and inventing a
 * constraint the DB doesn't have would make the API and the schema disagree.
 */
export async function createPartnerOrgForTenant(
  db: TenantBoundDb,
  tenantId: string,
  input: CreatePartnerOrgInput,
): Promise<CreatePartnerOrgOutput> {
  const [row] = await db
    .insert(partnerOrgs)
    .values({
      tenantId,
      name: input.name.trim(),
      tier: input.tier,
      country: input.country ? input.country.toUpperCase() : null,
      primaryContactEmail: normaliseEmail(input.primaryContactEmail),
      primaryContactPhone: input.primaryContactPhone ?? null,
      active: true,
      onboardedAt: new Date(),
    })
    .returning({ id: partnerOrgs.id });
  if (!row) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "partner_org_insert_no_row" });
  }
  return { partnerOrgId: row.id };
}

/**
 * Suspend / restore a partner org. Deliberately a flag flip and nothing else:
 * deactivating does NOT end assignments or revoke invitations — the partner's
 * inflight work stays intact and the flip is fully reversible. (Portal
 * sign-in is gated on partner_users.active, which a later ticket will cascade
 * from here if the demo needs it.)
 */
export async function setPartnerOrgActiveForTenant(
  db: TenantBoundDb,
  tenantId: string,
  input: SetPartnerOrgActiveInput,
): Promise<SetPartnerOrgActiveOutput> {
  const [row] = await db
    .update(partnerOrgs)
    .set({ active: input.active, updatedAt: new Date() })
    .where(and(eq(partnerOrgs.tenantId, tenantId), eq(partnerOrgs.id, input.partnerOrgId)))
    .returning({ id: partnerOrgs.id, active: partnerOrgs.active });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_org_not_found" });
  }
  return { partnerOrgId: row.id, active: row.active };
}

// ──────────────────────── invitation writes ────────────────────────

export interface InvitePartnerUserArgs extends InvitePartnerUserInput {
  tenantId: string;
  /** tenants.display_name — the "who is inviting you" in the email copy. */
  companyName: string;
  /** The inviting staff member's tenant_user_memberships.id, or null. */
  actorMembershipId: string | null;
}

/**
 * Mint a single-use invitation and enqueue the email.
 *
 * CONFLICT (not a silent re-issue) in two cases, because both mean the caller
 * is looking at stale state: the person is already an active portal user in
 * this org, or a live invitation for that email+org already exists. Revoking
 * and re-inviting is the explicit path for the second case.
 *
 * The enqueue runs inside the caller's tx, so a failure to queue the mail
 * rolls the invitation row back — an invitation nobody was told about is
 * worse than no invitation.
 */
export async function invitePartnerUserForTenant(
  db: TenantBoundDb,
  args: InvitePartnerUserArgs,
): Promise<InvitePartnerUserOutput> {
  const { tenantId, partnerOrgId } = args;
  const email = normaliseEmail(args.email);

  const [org] = await db
    .select({ id: partnerOrgs.id, name: partnerOrgs.name })
    .from(partnerOrgs)
    .where(and(eq(partnerOrgs.tenantId, tenantId), eq(partnerOrgs.id, partnerOrgId)))
    .limit(1);
  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_org_not_found" });
  }

  const [existingUser] = await db
    .select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(
      and(
        eq(partnerUsers.tenantId, tenantId),
        eq(partnerUsers.partnerOrgId, partnerOrgId),
        eq(sql`lower(${partnerUsers.email})`, email),
        eq(partnerUsers.active, true),
      ),
    )
    .limit(1);
  if (existingUser) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That email already belongs to an active user in this partner org.",
    });
  }

  const [livePending] = await db
    .select({ id: partnerInvitations.id })
    .from(partnerInvitations)
    .where(
      and(
        eq(partnerInvitations.tenantId, tenantId),
        eq(partnerInvitations.partnerOrgId, partnerOrgId),
        eq(sql`lower(${partnerInvitations.email})`, email),
        isNull(partnerInvitations.consumedAt),
        isNull(partnerInvitations.revokedAt),
        gt(partnerInvitations.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (livePending) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "There is already a pending invitation for that email. Revoke it to re-issue.",
    });
  }

  const rawToken = mintInviteToken();
  const expiresAt = new Date(Date.now() + PARTNER_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [inserted] = await db
    .insert(partnerInvitations)
    .values({
      tenantId,
      partnerOrgId,
      email,
      intendedRole: args.role,
      tokenHash: hashPartnerInviteToken(rawToken),
      expiresAt,
      createdByMembershipId: args.actorMembershipId,
    })
    .returning({ id: partnerInvitations.id });
  if (!inserted) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "partner_invitation_insert_no_row",
    });
  }

  const acceptUrl = partnerInviteAcceptUrl(rawToken);
  await enqueueNotification(db, {
    tenantId,
    recipientType: "partner",
    recipientEmail: email,
    templateKey: "partner.invitation",
    templateData: {
      inviteeName: args.fullName.trim(),
      partnerOrgName: org.name,
      companyName: args.companyName,
      acceptUrl,
      expiresAtFormatted: formatExpiryDate(expiresAt),
    },
    dedupKey: `partner_invitation:${inserted.id}`,
  });

  // acceptUrl is returned on purpose — staging email is Resend test-mode
  // (single deliverable inbox), so the internal surface has to be able to
  // copy the link out. This response is the last place the raw token exists.
  return { invitationId: inserted.id, expiresAt: expiresAt.toISOString(), acceptUrl };
}

/**
 * Kill a live invitation. The row is KEPT (revoked_at stamped) rather than
 * deleted: partner_invitations is the audit trail of who was offered access,
 * and a stamped row is also what makes the token_hash partial-unique index
 * release the hash for re-issue.
 */
export async function revokePartnerInvitationForTenant(
  db: TenantBoundDb,
  tenantId: string,
  invitationId: string,
): Promise<RevokePartnerInvitationOutput> {
  const [existing] = await db
    .select({
      id: partnerInvitations.id,
      consumedAt: partnerInvitations.consumedAt,
      revokedAt: partnerInvitations.revokedAt,
    })
    .from(partnerInvitations)
    .where(and(eq(partnerInvitations.tenantId, tenantId), eq(partnerInvitations.id, invitationId)))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_invitation_not_found" });
  }
  if (existing.consumedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That invitation has already been accepted and can no longer be revoked.",
    });
  }
  // Already revoked → idempotent no-op, report the original stamp.
  if (existing.revokedAt) {
    return { invitationId: existing.id, revokedAt: existing.revokedAt.toISOString() };
  }

  const revokedAt = new Date();
  const [row] = await db
    .update(partnerInvitations)
    .set({ revokedAt })
    .where(and(eq(partnerInvitations.tenantId, tenantId), eq(partnerInvitations.id, invitationId)))
    .returning({ id: partnerInvitations.id, revokedAt: partnerInvitations.revokedAt });
  if (!row?.revokedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_invitation_not_found" });
  }
  return { invitationId: row.id, revokedAt: row.revokedAt.toISOString() };
}

// ──────────────────────── assignment writes ────────────────────────

/**
 * Open a requisition to a partner org.
 *
 * A FRESH row is correct even when (org, req) already has history: the
 * uniqueness constraint is partial — uniq_partner_assignments_active covers
 * (tenant, org, req) WHERE status='active' — so ended assignments coexist and
 * a partner can be assigned, ended, and re-assigned later. Only an ACTIVE
 * assignment conflicts. `paused` deliberately does NOT conflict at the DB
 * level either, but we treat it as occupied here (see below) because
 * re-assigning a paused partner would silently create a second live-ish row.
 */
export async function assignRequisitionToPartnerForTenant(
  db: TenantBoundDb,
  tenantId: string,
  input: AssignRequisitionToPartnerInput,
  actorMembershipId: string | null,
): Promise<AssignRequisitionToPartnerOutput> {
  const [org] = await db
    .select({ id: partnerOrgs.id })
    .from(partnerOrgs)
    .where(and(eq(partnerOrgs.tenantId, tenantId), eq(partnerOrgs.id, input.partnerOrgId)))
    .limit(1);
  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_org_not_found" });
  }

  const [req] = await db
    .select({ id: requisitions.id })
    .from(requisitions)
    .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, input.requisitionId)))
    .limit(1);
  if (!req) {
    throw new TRPCError({ code: "NOT_FOUND", message: "requisition_not_found" });
  }

  const [live] = await db
    .select({ id: partnerAssignments.id, status: partnerAssignments.status })
    .from(partnerAssignments)
    .where(
      and(
        eq(partnerAssignments.tenantId, tenantId),
        eq(partnerAssignments.partnerOrgId, input.partnerOrgId),
        eq(partnerAssignments.requisitionId, input.requisitionId),
        sql`${partnerAssignments.status} <> 'ended'`,
      ),
    )
    .limit(1);
  if (live) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "That requisition is already assigned to this partner.",
    });
  }

  const [row] = await db
    .insert(partnerAssignments)
    .values({
      tenantId,
      partnerOrgId: input.partnerOrgId,
      requisitionId: input.requisitionId,
      assignedByMembershipId: actorMembershipId,
      status: "active",
    })
    .returning({ id: partnerAssignments.id });
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "partner_assignment_insert_no_row",
    });
  }
  return { assignmentId: row.id };
}

/**
 * Close an assignment. The row stays (it's the history the internal detail
 * view shows); the partner portal's list filters on status='active', so the
 * req disappears from their dashboard immediately. Idempotent: ending an
 * already-ended assignment returns the original ended_at rather than
 * rewriting it.
 */
export async function endPartnerAssignmentForTenant(
  db: TenantBoundDb,
  tenantId: string,
  assignmentId: string,
): Promise<EndPartnerAssignmentOutput> {
  const [existing] = await db
    .select({
      id: partnerAssignments.id,
      status: partnerAssignments.status,
      endedAt: partnerAssignments.endedAt,
    })
    .from(partnerAssignments)
    .where(and(eq(partnerAssignments.tenantId, tenantId), eq(partnerAssignments.id, assignmentId)))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_assignment_not_found" });
  }
  if (existing.status === "ended" && existing.endedAt) {
    return { assignmentId: existing.id, endedAt: existing.endedAt.toISOString() };
  }

  const endedAt = new Date();
  const [row] = await db
    .update(partnerAssignments)
    .set({ status: "ended", endedAt })
    .where(and(eq(partnerAssignments.tenantId, tenantId), eq(partnerAssignments.id, assignmentId)))
    .returning({ id: partnerAssignments.id, endedAt: partnerAssignments.endedAt });
  if (!row?.endedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "partner_assignment_not_found" });
  }
  return { assignmentId: row.id, endedAt: row.endedAt.toISOString() };
}

// ──────────────────── ownership-claim writes (P0.3) ────────────────────

/**
 * Release a partner's exclusivity window early — the human half of the claim
 * lifecycle (the time-driven half is the worker's ownership_claim_sweep).
 *
 * ONE statement, with status='active' IN THE PREDICATE rather than a
 * read-then-write: the partial unique index only allows one active claim per
 * person, so two concurrent releases must not both believe they won, and an
 * UPDATE … WHERE status='active' RETURNING settles that in the row lock. No
 * row back means one of three indistinguishable things — the claim isn't this
 * tenant's, it doesn't exist, or it is no longer active — and all three
 * legitimately answer NOT_FOUND: a released/expired claim is not a claim you
 * can release, and telling a caller which of the three it was would leak
 * across tenants. (Deliberately NOT idempotent-on-repeat like
 * revokePartnerInvitation: released_at/released_reason are the dispute record,
 * so a second release must not silently re-report the first one's stamp under
 * a new reason.)
 *
 * released_at + released_reason are what the columns were added for and, until
 * this function existed, nothing in the codebase ever wrote either. The row
 * stays — status='released' is the history the internal claims table shows,
 * and the audit trigger records the transition.
 *
 * The freed person can be claimed again immediately: the partial unique index
 * counts only active rows.
 */
export async function releaseOwnershipClaimForTenant(
  db: TenantBoundDb,
  tenantId: string,
  input: ReleaseOwnershipClaimInput,
): Promise<ReleaseOwnershipClaimOutput> {
  const releasedAt = new Date();
  const [row] = await db
    .update(candidateOwnershipClaims)
    .set({
      status: "released",
      releasedAt,
      releasedReason: input.reason.trim(),
    })
    .where(
      and(
        eq(candidateOwnershipClaims.tenantId, tenantId),
        eq(candidateOwnershipClaims.id, input.claimId),
        eq(candidateOwnershipClaims.status, "active"),
      ),
    )
    .returning({
      id: candidateOwnershipClaims.id,
      releasedAt: candidateOwnershipClaims.releasedAt,
    });
  if (!row?.releasedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "active_ownership_claim_not_found" });
  }
  return { claimId: row.id, releasedAt: row.releasedAt.toISOString() };
}
