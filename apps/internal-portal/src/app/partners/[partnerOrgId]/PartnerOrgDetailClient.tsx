"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type {
  GetPartnerOrgCommercialsOutput,
  GetPartnerOrgOutput,
  ListPartnerOrgClaimsOutput,
  ListPartnerOrgDedupAttemptsOutput,
  PartnerFeeModelValue,
  PartnerExclusivityScopeValue,
  PartnerOrgAssignmentRow,
  PartnerOrgClaimRow,
  PartnerOrgDedupAttemptRow,
  PartnerOrgFeeRow,
  PartnerOrgInvitationRow,
  PartnerOrgUserRow,
  PartnerUserRoleValue,
  RequisitionSummary,
} from "@hireops/api-types";
import { Input, Select, Button } from "@hireops/ui";
import {
  Card,
  Badge,
  StatTile,
  EmptyState,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { PageHeader } from "@/components/patterns";
import { humanize } from "@/lib/labels";
import { formatFeeMinor } from "@/lib/money";
import { trpc } from "@/lib/trpc-client";
import { fmtDate, tierLabel } from "../PartnersClient";

/**
 * P0.1B — one partner organisation's administration surface.
 *
 * Blocks, each backed by a real procedure: the org header (with the suspend /
 * restore toggle), the portal users the org already has, the live invitations
 * (issue + revoke), the requisition assignments (assign + end, ended rows kept
 * as history — the internal view is the record), (P2.2) the commercial terms
 * and the fees accrued under them, and (P0.3) the ownership claims this partner
 * holds, with the early-release action.
 *
 * The invitation accept link is shown exactly once, in a panel, because that
 * is the truth: only the sha256 of the token is persisted, so once this panel
 * is dismissed the link cannot be recovered — it can only be revoked and
 * re-issued.
 */

/** Requisition statuses it makes sense to hand a partner. */
const ASSIGNABLE_REQ_STATUSES = new Set(["approved", "posted", "on_hold"]);

const PARTNER_ROLE_OPTIONS = [
  { value: "partner_admin", label: "Partner admin" },
  { value: "partner_user", label: "Partner user" },
];

/** ISO → "07 Jul 2026, 14:30". Used where the time matters (invite expiry). */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The API's machine-readable NOT_FOUND messages aren't for humans; its
 * CONFLICT messages already are, so those pass straight through.
 */
function friendlyError(message: string): string {
  switch (message) {
    case "partner_org_not_found":
      return "That partner organisation is no longer here. Reload the page.";
    case "partner_invitation_not_found":
      return "That invitation is no longer here. Reload the page.";
    case "partner_assignment_not_found":
      return "That assignment is no longer here. Reload the page.";
    case "requisition_not_found":
      return "That requisition is no longer here. Reload the page.";
    case "active_ownership_claim_not_found":
      return "That claim is no longer active — it may have expired or been released already. Reload the page.";
    default:
      return message;
  }
}

export function PartnerOrgDetailClient({
  partnerOrgId,
  initial,
  initialClaims,
  initialDedupAttempts,
  initialCommercials,
  requisitionOptions,
}: {
  partnerOrgId: string;
  initial: GetPartnerOrgOutput;
  initialClaims: ListPartnerOrgClaimsOutput;
  initialDedupAttempts: ListPartnerOrgDedupAttemptsOutput;
  initialCommercials: GetPartnerOrgCommercialsOutput;
  /** null when the session's roles can't read the requisition list (hr_ops). */
  requisitionOptions: RequisitionSummary[] | null;
}) {
  const utils = trpc.useUtils();
  const query = trpc.getPartnerOrg.useQuery(
    { partnerOrgId },
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: false },
  );
  const data = query.data ?? initial;
  const { org, users, pendingInvitations, assignments } = data;

  const refresh = () => {
    void utils.getPartnerOrg.invalidate({ partnerOrgId });
    void utils.listPartnerOrgs.invalidate();
  };

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setActive = trpc.setPartnerOrgActive.useMutation({
    onSuccess: (res) => {
      setError(null);
      setNotice(
        res.active
          ? `${org.name} is active again. Its users can sign in to the partner portal.`
          : `${org.name} is suspended. Its users can no longer sign in; assignments and claims are untouched.`,
      );
      refresh();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  function toggleActive() {
    const next = !org.active;
    const ok = window.confirm(
      next
        ? `Restore ${org.name}? Its portal users will be able to sign in again.`
        : `Suspend ${org.name}? Its portal users will lose access immediately. Existing assignments and claims are kept.`,
    );
    if (!ok) return;
    setActive.mutate({ partnerOrgId, active: next });
  }

  return (
    <PageContainer className="space-y-6">
      <div>
        <Link href="/partners" className="text-sm text-neutral-500 hover:underline">
          ← All partners
        </Link>
      </div>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{org.name}</span>
            <Badge tone={org.tier === "empanelled" ? "accent" : "neutral"}>
              {tierLabel(org.tier)}
            </Badge>
            <Badge tone={org.active ? "success" : "neutral"}>
              {org.active ? "Active" : "Suspended"}
            </Badge>
          </span>
        }
        subtitle={org.legalEntityName ?? undefined}
        right={
          <Button
            variant={org.active ? "secondary" : "primary"}
            onClick={toggleActive}
            disabled={setActive.isPending}
          >
            {setActive.isPending ? "Saving…" : org.active ? "Suspend partner" : "Restore partner"}
          </Button>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Portal users" value={org.userCount} hint="Active partner logins" />
        <StatTile
          label="Active assignments"
          value={org.activeAssignmentCount}
          hint="Requisitions this partner may source against"
        />
        <StatTile
          label="Active claims"
          value={org.activeClaimCount}
          hint="Live candidate ownership claims"
        />
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Contact</h2>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-4">
          <Field label="Primary email" value={org.primaryContactEmail} />
          <Field label="Phone" value={org.primaryContactPhone} />
          <Field label="Country" value={org.country} />
          <Field label="Onboarded" value={fmtDate(org.onboardedAt)} />
        </dl>
      </Card>

      <UsersSection users={users} />

      <InvitationsSection
        partnerOrgId={partnerOrgId}
        orgName={org.name}
        invitations={pendingInvitations}
        onChanged={refresh}
      />

      <AssignmentsSection
        partnerOrgId={partnerOrgId}
        assignments={assignments}
        requisitionOptions={requisitionOptions}
        onChanged={refresh}
      />

      <CommercialsSection
        partnerOrgId={partnerOrgId}
        orgName={org.name}
        initialCommercials={initialCommercials}
      />

      <ClaimsSection
        partnerOrgId={partnerOrgId}
        initialClaims={initialClaims}
        onChanged={refresh}
      />

      <DedupAttemptsSection
        partnerOrgId={partnerOrgId}
        initialDedupAttempts={initialDedupAttempts}
      />
    </PageContainer>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </dt>
      <dd className="mt-1 text-neutral-800">{value ?? "—"}</dd>
    </div>
  );
}

// ─────────────────────────── users ───────────────────────────

function UsersSection({ users }: { users: PartnerOrgUserRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Portal users</h2>
      {users.length === 0 ? (
        <Card>
          <EmptyState
            title="No portal users yet"
            hint="Invite this partner's first user below. They become a user only once they accept the invitation."
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Last sign-in</Th>
          </Thead>
          <Tbody>
            {users.map((u) => (
              <Tr key={u.partnerUserId}>
                <Td className="font-medium text-neutral-900">{u.fullName}</Td>
                <Td label="Email">{u.email}</Td>
                <Td label="Role">
                  <Badge tone={u.role === "partner_admin" ? "info" : "neutral"}>
                    {humanize(u.role)}
                  </Badge>
                </Td>
                <Td label="Status">
                  <Badge tone={u.active ? "success" : "neutral"}>
                    {u.active ? "Active" : "Inactive"}
                  </Badge>
                </Td>
                <Td label="Last sign-in">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never"}</Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </section>
  );
}

// ──────────────────────── invitations ────────────────────────

function InvitationsSection({
  partnerOrgId,
  orgName,
  invitations,
  onChanged,
}: {
  partnerOrgId: string;
  orgName: string;
  invitations: PartnerOrgInvitationRow[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    email: string;
    acceptUrl: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<PartnerUserRoleValue>("partner_user");

  const invite = trpc.invitePartnerUser.useMutation({
    onSuccess: (res) => {
      setError(null);
      setIssued({ email: email.trim(), acceptUrl: res.acceptUrl, expiresAt: res.expiresAt });
      setCopied(false);
      setEmail("");
      setFullName("");
      setRole("partner_user");
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  const revoke = trpc.revokePartnerInvitation.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  async function copyLink() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.acceptUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const canSubmit = email.trim().length > 0 && fullName.trim().length > 0 && !invite.isPending;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Invitations</h2>

      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {issued ? (
        <Card className="border-status-warning-200 bg-status-warning-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-status-warning-800">
                Invitation sent to {issued.email}
              </h3>
              <p className="mt-1 text-xs text-status-warning-800">
                The accept link below is shown <strong>only once</strong> — only its hash is stored,
                so it cannot be retrieved again. If you lose it, revoke the invitation and re-issue.
                It expires {fmtDateTime(issued.expiresAt)}.
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 text-sm text-neutral-600 hover:underline"
              onClick={() => setIssued(null)}
            >
              Dismiss
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-button border border-status-warning-200 bg-white px-3 py-2 text-xs text-neutral-800">
              {issued.acceptUrl}
            </code>
            <Button variant="secondary" onClick={copyLink}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </Card>
      ) : null}

      {invitations.length === 0 ? (
        <p className="text-sm text-neutral-500">No pending invitations.</p>
      ) : (
        <TableShell>
          <Thead>
            <Th>Email</Th>
            <Th>Intended role</Th>
            <Th>Issued</Th>
            <Th>Expires</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Thead>
          <Tbody>
            {invitations.map((inv) => (
              <Tr key={inv.invitationId}>
                <Td className="font-medium text-neutral-900">{inv.email}</Td>
                <Td label="Intended role">
                  <Badge tone={inv.intendedRole === "partner_admin" ? "info" : "neutral"}>
                    {humanize(inv.intendedRole)}
                  </Badge>
                </Td>
                <Td label="Issued">{fmtDateTime(inv.createdAt)}</Td>
                <Td label="Expires">{fmtDateTime(inv.expiresAt)}</Td>
                <Td className="lg:text-right">
                  <button
                    type="button"
                    className="text-sm text-status-error-700 hover:underline disabled:opacity-50"
                    disabled={revoke.isPending}
                    onClick={() => {
                      const ok = window.confirm(
                        `Revoke the invitation for ${inv.email}? Their link stops working immediately.`,
                      );
                      if (!ok) return;
                      revoke.mutate({ invitationId: inv.invitationId });
                    }}
                  >
                    Revoke
                  </button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-neutral-900">Invite a user to {orgName}</h3>
        <p className="mb-4 mt-1 text-xs text-neutral-600">
          Sends the invitation email and returns the accept link here as well, because staging mail
          only reaches one inbox. The invitee&apos;s name is used in the email; it isn&apos;t stored
          on the invitation.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="recruiter@partner.example"
          />
          <Input
            label="Full name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Priya Nair"
          />
          <Select
            label="Role"
            options={PARTNER_ROLE_OPTIONS}
            value={role}
            onValueChange={(v) => setRole(v as PartnerUserRoleValue)}
            hint="Partner admins can manage their own org's users."
          />
        </div>
        <div className="mt-5">
          <Button
            onClick={() => {
              setError(null);
              invite.mutate({
                partnerOrgId,
                email: email.trim(),
                fullName: fullName.trim(),
                role,
              });
            }}
            disabled={!canSubmit}
          >
            {invite.isPending ? "Sending…" : "Send invitation"}
          </Button>
        </div>
      </Card>
    </section>
  );
}

// ─────────────────────── commercial terms (P2.2) ───────────────────────

const FEE_MODEL_OPTIONS = [
  { value: "percentage_ctc", label: "Percentage of CTC" },
  { value: "flat_per_hire", label: "Flat fee per hire" },
];

const EXCLUSIVITY_SCOPE_OPTIONS = [
  { value: "org_wide", label: "Org-wide" },
  { value: "req_only", label: "Requisition only" },
];

const FEE_MODEL_LABELS: Record<PartnerFeeModelValue, string> = {
  percentage_ctc: "Percentage of CTC",
  flat_per_hire: "Flat fee per hire",
};

const EXCLUSIVITY_SCOPE_LABELS: Record<PartnerExclusivityScopeValue, string> = {
  org_wide: "Org-wide",
  req_only: "Requisition only",
};

/** Fee status → badge tone. Only `paid` is settled; `disputed` is a problem. */
function feeTone(status: PartnerOrgFeeRow["status"]): "success" | "warning" | "info" | "error" {
  if (status === "paid") return "success";
  if (status === "payable") return "info";
  if (status === "disputed") return "error";
  return "warning";
}

/**
 * P2.2 — the commercial terms behind this partner, and the fees they have
 * accrued under them.
 *
 * The one thing this section has to make unmistakable is that saving is NOT an
 * edit. partner_msa keeps one live row per org; changing terms closes the
 * current row and opens a new one, and every fee already accrued keeps the
 * terms frozen on it. A user who believes they corrected a record would
 * otherwise expect old fees to move, and they never will — so the form says so
 * above the button, not in a tooltip.
 *
 * The empty state is equally literal: with no MSA on file, a hire by this
 * partner accrues NOTHING. That is the accrual's actual behaviour (it logs
 * `partner_fee.no_msa` and returns rather than inventing a default percentage),
 * and a surface that implied otherwise would be the only thing standing between
 * staff and a missing invoice.
 */
function CommercialsSection({
  partnerOrgId,
  orgName,
  initialCommercials,
}: {
  partnerOrgId: string;
  orgName: string;
  initialCommercials: GetPartnerOrgCommercialsOutput;
}) {
  const utils = trpc.useUtils();
  const query = trpc.getPartnerOrgCommercials.useQuery(
    { partnerOrgId },
    { initialData: initialCommercials, staleTime: 5_000, refetchOnWindowFocus: false },
  );
  const data = query.data ?? initialCommercials;
  const { msa, fees, rollups } = data;

  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state is strings — these are text inputs, and an empty field has to
  // stay empty rather than snapping to 0 while it is being typed into.
  const [feeModel, setFeeModel] = useState<PartnerFeeModelValue>("percentage_ctc");
  const [feePercent, setFeePercent] = useState("");
  const [flatFeeMajor, setFlatFeeMajor] = useState("");
  const [feeCurrency, setFeeCurrency] = useState("INR");
  const [windowDays, setWindowDays] = useState("90");
  const [scope, setScope] = useState<PartnerExclusivityScopeValue>("org_wide");
  const [holdbackPercent, setHoldbackPercent] = useState("25");
  const [guaranteeDays, setGuaranteeDays] = useState("90");

  const upsert = trpc.upsertPartnerMsa.useMutation({
    onSuccess: (res) => {
      setError(null);
      setEditing(false);
      setNotice(
        res.closedMsaId
          ? "New terms are live. The previous version was closed off — fees already accrued keep the terms they were computed under."
          : "Terms agreed. Hires this partner sources from now on will accrue a fee.",
      );
      void utils.getPartnerOrgCommercials.invalidate({ partnerOrgId });
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  /** Open the form, pre-filled from the live terms (or the org defaults). */
  function openForm() {
    setNotice(null);
    setError(null);
    setFeeModel(msa?.feeModel ?? "percentage_ctc");
    setFeePercent(msa?.feePercent != null ? String(msa.feePercent) : "");
    setFlatFeeMajor(msa?.flatFeeMinor != null ? String(msa.flatFeeMinor / 100) : "");
    setFeeCurrency(msa?.feeCurrency ?? "INR");
    setWindowDays(String(msa?.exclusivityWindowDays ?? 90));
    setScope(msa?.exclusivityScope ?? "org_wide");
    setHoldbackPercent(String(msa?.probationHoldbackPercent ?? 25));
    setGuaranteeDays(String(msa?.replacementGuaranteeDays ?? 90));
    setEditing(true);
  }

  const isPercentage = feeModel === "percentage_ctc";
  const operandFilled = isPercentage ? feePercent.trim() !== "" : flatFeeMajor.trim() !== "";
  const canSubmit =
    operandFilled &&
    /^[A-Za-z]{3}$/.test(feeCurrency.trim()) &&
    windowDays.trim() !== "" &&
    holdbackPercent.trim() !== "" &&
    guaranteeDays.trim() !== "" &&
    !upsert.isPending;

  function submit() {
    setError(null);
    upsert.mutate({
      partnerOrgId,
      feeModel,
      // Only the operand the chosen model uses is sent; the API stores the
      // other as NULL regardless, and the DB CHECK requires this one.
      feePercent: isPercentage ? Number(feePercent) : undefined,
      // Money crosses the wire as minor units — this field is whole currency.
      flatFeeMinor: isPercentage ? undefined : Math.round(Number(flatFeeMajor) * 100),
      feeCurrency: feeCurrency.trim().toUpperCase(),
      exclusivityWindowDays: Number(windowDays),
      exclusivityScope: scope,
      probationHoldbackPercent: Number(holdbackPercent),
      replacementGuaranteeDays: Number(guaranteeDays),
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-neutral-900">Commercial terms</h2>
        {editing ? null : (
          <Button variant="secondary" onClick={openForm}>
            {msa ? "Change terms" : "Agree terms"}
          </Button>
        )}
      </div>

      {notice ? (
        <div className="rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {msa ? (
        <Card className="p-5">
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-4">
            <Field label="Fee model" value={FEE_MODEL_LABELS[msa.feeModel]} />
            <Field
              label="Fee"
              value={
                msa.feeModel === "percentage_ctc"
                  ? `${msa.feePercent ?? 0}% of annual base`
                  : `${formatFeeMinor(msa.flatFeeMinor, msa.feeCurrency)} per hire`
              }
            />
            <Field label="Exclusivity window" value={`${msa.exclusivityWindowDays} days`} />
            <Field
              label="Exclusivity scope"
              value={EXCLUSIVITY_SCOPE_LABELS[msa.exclusivityScope]}
            />
            <Field label="Probation holdback" value={`${msa.probationHoldbackPercent}%`} />
            <Field label="Replacement guarantee" value={`${msa.replacementGuaranteeDays} days`} />
            <Field label="Currency" value={msa.feeCurrency} />
            <Field label="In force since" value={fmtDate(msa.effectiveFrom)} />
          </dl>
        </Card>
      ) : (
        <Card>
          <EmptyState
            title="No MSA on file"
            hint={`Fees don't accrue until terms are agreed — a hire ${orgName} sources today would create no fee at all. Agree terms to start the clock.`}
          />
        </Card>
      )}

      {editing ? (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-neutral-900">
            {msa ? `Change ${orgName}'s terms` : `Agree terms with ${orgName}`}
          </h3>
          <p className="mb-4 mt-1 text-xs text-neutral-600">
            Saving opens a <strong>new terms version</strong> rather than editing this one: the
            current terms are closed off with today&apos;s date and fees already accrued keep the
            terms they were computed under. The exclusivity window applies to ownership claims
            created from the moment it is saved.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Select
              label="Fee model"
              options={FEE_MODEL_OPTIONS}
              value={feeModel}
              onValueChange={(v) => setFeeModel(v as PartnerFeeModelValue)}
            />
            {isPercentage ? (
              <Input
                label="Fee percent"
                type="number"
                required
                value={feePercent}
                onChange={(e) => setFeePercent(e.target.value)}
                placeholder="20"
                hint="Percent of the accepted offer's annual base."
              />
            ) : (
              <Input
                label={`Flat fee per hire (${feeCurrency.toUpperCase()})`}
                type="number"
                required
                value={flatFeeMajor}
                onChange={(e) => setFlatFeeMajor(e.target.value)}
                placeholder="300000"
                hint="Whole currency units, not paise."
              />
            )}
            <Input
              label="Currency"
              required
              value={feeCurrency}
              onChange={(e) => setFeeCurrency(e.target.value.toUpperCase())}
              placeholder="INR"
              hint="3-letter ISO code."
            />
            <Input
              label="Exclusivity window (days)"
              type="number"
              required
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              hint="How long an ownership claim on a submitted candidate lasts."
            />
            <Select
              label="Exclusivity scope"
              options={EXCLUSIVITY_SCOPE_OPTIONS}
              value={scope}
              onValueChange={(v) => setScope(v as PartnerExclusivityScopeValue)}
            />
            <Input
              label="Probation holdback (%)"
              type="number"
              required
              value={holdbackPercent}
              onChange={(e) => setHoldbackPercent(e.target.value)}
              hint="Share of the fee held back until the guarantee period ends."
            />
            <Input
              label="Replacement guarantee (days)"
              type="number"
              required
              value={guaranteeDays}
              onChange={(e) => setGuaranteeDays(e.target.value)}
              hint="Sets each fee's holdback release date, counted from the hire."
            />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button onClick={submit} disabled={!canSubmit}>
              {upsert.isPending ? "Saving…" : msa ? "Save as new version" : "Agree terms"}
            </Button>
            <button
              type="button"
              className="text-sm text-neutral-600 hover:underline"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Accrued"
          value={formatFeeMinor(rollups.accruedMinor, rollups.currency)}
          hint="In the holdback window"
        />
        <StatTile
          label="Payable"
          value={formatFeeMinor(rollups.payableMinor, rollups.currency)}
          hint="Holdback released, not yet paid"
        />
        <StatTile
          label="Paid"
          value={formatFeeMinor(rollups.paidMinor, rollups.currency)}
          hint="Settled with the partner"
        />
      </div>

      {fees.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No fees have accrued for this partner. One is created automatically when a candidate they
          sourced accepts an offer, provided terms are on file at that moment.
        </p>
      ) : (
        <TableShell>
          <Thead>
            <Th>Candidate</Th>
            <Th>Requisition</Th>
            <Th>Fee</Th>
            <Th>Status</Th>
            <Th>Holdback release</Th>
            <Th>Hired</Th>
          </Thead>
          <Tbody>
            {fees.map((f) => (
              <Tr key={f.feeId}>
                <Td className="font-medium text-neutral-900">{f.candidateName ?? "—"}</Td>
                <Td label="Requisition">{f.requisitionTitle ?? "—"}</Td>
                <Td label="Fee">
                  <span>
                    {formatFeeMinor(f.feeMinor, f.feeCurrency)}
                    <span className="block text-xs text-neutral-500">
                      {f.feeModel === "percentage_ctc"
                        ? `${f.feePercent ?? 0}% of base`
                        : f.feeModel === "flat_per_hire"
                          ? "Flat per hire"
                          : "Terms not recorded"}
                    </span>
                  </span>
                </Td>
                <Td label="Status">
                  <Badge tone={feeTone(f.status)}>{humanize(f.status)}</Badge>
                </Td>
                <Td label="Holdback release">{fmtDate(f.holdbackReleaseAt)}</Td>
                <Td label="Hired">{fmtDate(f.hiredAt)}</Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </section>
  );
}

// ─────────────────────── ownership claims ───────────────────────

/** Claim status → badge tone. Only `active` is a live exclusivity window. */
function claimTone(status: PartnerOrgClaimRow["status"]): "success" | "warning" | "neutral" {
  if (status === "active") return "success";
  if (status === "released") return "warning";
  return "neutral";
}

/**
 * P0.3 — the exclusivity windows this partner holds, and the early exit.
 *
 * The whole history is shown, not just the live claims: `expired` and
 * `released` rows are how staff answer "who owned this candidate in March",
 * which is the question a partner-attribution dispute actually asks.
 *
 * Release is a two-step because it is not reversible and it takes something
 * away from the partner: the row's button opens a panel that requires a
 * reason, and the reason is stored on the claim. Expiry, by contrast, is not a
 * button anywhere — the worker's sweep owns it.
 */
function ClaimsSection({
  partnerOrgId,
  initialClaims,
  onChanged,
}: {
  partnerOrgId: string;
  initialClaims: ListPartnerOrgClaimsOutput;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const query = trpc.listPartnerOrgClaims.useQuery(
    { partnerOrgId },
    { initialData: initialClaims, staleTime: 5_000, refetchOnWindowFocus: false },
  );
  const claims = (query.data ?? initialClaims).items;

  const [error, setError] = useState<string | null>(null);
  const [pendingRelease, setPendingRelease] = useState<PartnerOrgClaimRow | null>(null);
  const [reason, setReason] = useState("");

  const release = trpc.releaseOwnershipClaim.useMutation({
    onSuccess: () => {
      setError(null);
      setPendingRelease(null);
      setReason("");
      void utils.listPartnerOrgClaims.invalidate({ partnerOrgId });
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Ownership claims</h2>

      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {pendingRelease ? (
        <Card className="border-status-warning-200 bg-status-warning-50 p-5">
          <h3 className="text-sm font-semibold text-status-warning-800">
            Release the claim on {pendingRelease.candidateName ?? "this candidate"}?
          </h3>
          <p className="mt-1 text-xs text-status-warning-800">
            This ends the partner&apos;s exclusivity immediately and cannot be undone. Another
            partner can submit this candidate from that moment on. The reason is stored on the claim
            and is what we show if the partner queries the attribution.
          </p>
          <div className="mt-3 max-w-xl">
            <Input
              label="Reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Partner confirmed by email they are standing down on this candidate"
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => {
                setError(null);
                release.mutate({ claimId: pendingRelease.claimId, reason: reason.trim() });
              }}
              disabled={reason.trim().length === 0 || release.isPending}
            >
              {release.isPending ? "Releasing…" : "Release claim"}
            </Button>
            <button
              type="button"
              className="text-sm text-neutral-600 hover:underline"
              onClick={() => {
                setPendingRelease(null);
                setReason("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </Card>
      ) : null}

      {claims.length === 0 ? (
        <p className="text-sm text-neutral-500">
          This partner holds no candidate ownership claims. A claim is created when they submit a
          candidate, and it runs for 90 days.
        </p>
      ) : (
        <TableShell>
          <Thead>
            <Th>Candidate</Th>
            <Th>Status</Th>
            <Th>Claimed</Th>
            <Th>Expires</Th>
            <Th>Released</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Thead>
          <Tbody>
            {claims.map((c) => (
              <Tr key={c.claimId} className={c.status === "active" ? "" : "text-neutral-500"}>
                <Td className="font-medium text-neutral-900">{c.candidateName ?? "—"}</Td>
                <Td label="Status">
                  <Badge tone={claimTone(c.status)}>{humanize(c.status)}</Badge>
                </Td>
                <Td label="Claimed">{fmtDate(c.claimedAt)}</Td>
                <Td label="Expires">{fmtDate(c.expiresAt)}</Td>
                <Td label="Released">
                  {c.releasedAt ? (
                    <span>
                      {fmtDate(c.releasedAt)}
                      {c.releasedReason ? (
                        <span className="block text-xs text-neutral-500">{c.releasedReason}</span>
                      ) : null}
                    </span>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td className="lg:text-right">
                  {c.status === "active" ? (
                    <button
                      type="button"
                      className="text-sm text-status-error-700 hover:underline disabled:opacity-50"
                      disabled={release.isPending}
                      onClick={() => {
                        setError(null);
                        setReason("");
                        setPendingRelease(c);
                      }}
                    >
                      Release
                    </button>
                  ) : (
                    <span className="text-sm text-neutral-400">—</span>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </section>
  );
}

// ─────────────────────── submission disputes ───────────────────────

/** Dedup decision → badge tone. Only the two `block_*` outcomes turned a
 * partner away, and those are the rows a dispute is ever about. */
function dedupTone(
  decision: PartnerOrgDedupAttemptRow["decision"],
): "success" | "warning" | "neutral" {
  if (decision === "allow_new") return "success";
  if (decision === "link_existing") return "neutral";
  return "warning";
}

/** The decision enum in the words a human uses about it. */
const DEDUP_DECISION_LABELS: Record<PartnerOrgDedupAttemptRow["decision"], string> = {
  allow_new: "Accepted — new candidate",
  link_existing: "Accepted — matched existing",
  block_active_claim: "Blocked — another partner owns them",
  block_in_pipeline: "Blocked — already in the pipeline",
};

/**
 * P0.5 — every dedup decision this partner's submissions ran into.
 *
 * Read-only, and not for want of effort: candidate_dedup_attempts is
 * append-only (it IS the audit log for the dedup gate), so there is nothing
 * here to edit or retract. What it is FOR is the phone call — "we sent that
 * candidate to you first" — which the claims table above can only half answer,
 * because a blocked submission never becomes a claim and so leaves no trace in
 * it. This section is the other half: the attempt, the moment, and the reason
 * it was turned away.
 *
 * Privacy is the claims table's: the matched candidate's display name and
 * nothing else. The email and phone the partner typed are on the row in the
 * database and deliberately not on this page.
 */
function DedupAttemptsSection({
  partnerOrgId,
  initialDedupAttempts,
}: {
  partnerOrgId: string;
  initialDedupAttempts: ListPartnerOrgDedupAttemptsOutput;
}) {
  const query = trpc.listPartnerOrgDedupAttempts.useQuery(
    { partnerOrgId },
    { initialData: initialDedupAttempts, staleTime: 5_000, refetchOnWindowFocus: false },
  );
  const data = query.data ?? initialDedupAttempts;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Submission disputes</h2>

      {data.items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No submission attempts recorded for this partner yet. Every candidate they submit is
          checked against the existing pipeline, and the outcome of that check lands here.
        </p>
      ) : (
        <>
          <TableShell>
            <Thead>
              <Th>Candidate</Th>
              <Th>Outcome</Th>
              <Th>Reason</Th>
              <Th>Submitted by</Th>
              <Th>Attempted</Th>
            </Thead>
            <Tbody>
              {data.items.map((a) => (
                <Tr key={a.attemptId}>
                  <Td className="font-medium text-neutral-900">{a.candidateName ?? "—"}</Td>
                  <Td label="Outcome">
                    <Badge tone={dedupTone(a.decision)}>{DEDUP_DECISION_LABELS[a.decision]}</Badge>
                  </Td>
                  <Td label="Reason">{a.decisionReason ? humanize(a.decisionReason) : "—"}</Td>
                  <Td label="Submitted by">{a.attemptedByName}</Td>
                  <Td label="Attempted">{fmtDateTime(a.attemptedAt)}</Td>
                </Tr>
              ))}
            </Tbody>
          </TableShell>
          {data.capped ? (
            <p className="text-xs text-neutral-500">
              Showing the {data.items.length} most recent attempts. This partner has more on record.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// ──────────────────────── assignments ────────────────────────

function AssignmentsSection({
  partnerOrgId,
  assignments,
  requisitionOptions,
  onChanged,
}: {
  partnerOrgId: string;
  assignments: PartnerOrgAssignmentRow[];
  requisitionOptions: RequisitionSummary[] | null;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");

  const assign = trpc.assignRequisitionToPartner.useMutation({
    onSuccess: () => {
      setError(null);
      setSelected("");
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  const end = trpc.endPartnerAssignment.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  // A requisition already live with this partner can't be assigned again
  // (the API answers CONFLICT), so it isn't offered.
  const liveRequisitionIds = useMemo(
    () => new Set(assignments.filter((a) => a.status !== "ended").map((a) => a.requisitionId)),
    [assignments],
  );

  const options = useMemo(() => {
    if (!requisitionOptions) return [];
    return requisitionOptions
      .filter((r) => ASSIGNABLE_REQ_STATUSES.has(r.status) && !liveRequisitionIds.has(r.id))
      .map((r) => ({
        value: r.id,
        label: `${r.title ?? "Untitled requisition"} — ${humanize(r.status)}`,
      }));
  }, [requisitionOptions, liveRequisitionIds]);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Requisition assignments</h2>

      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {assignments.length === 0 ? (
        <p className="text-sm text-neutral-500">
          This partner has never been assigned a requisition, so it sees nothing in the partner
          portal.
        </p>
      ) : (
        <TableShell>
          <Thead>
            <Th>Requisition</Th>
            <Th>Requisition status</Th>
            <Th>Assignment</Th>
            <Th>Assigned</Th>
            <Th>Ended</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Thead>
          <Tbody>
            {assignments.map((a) => (
              <Tr key={a.assignmentId} className={a.status === "ended" ? "text-neutral-500" : ""}>
                <Td className="font-medium text-neutral-900">{a.title}</Td>
                <Td label="Requisition status">{humanize(a.requisitionStatus)}</Td>
                <Td label="Assignment">
                  <Badge
                    tone={
                      a.status === "active"
                        ? "success"
                        : a.status === "paused"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {humanize(a.status)}
                  </Badge>
                </Td>
                <Td label="Assigned">{fmtDate(a.assignedAt)}</Td>
                <Td label="Ended">{fmtDate(a.endedAt)}</Td>
                <Td className="lg:text-right">
                  {a.status === "ended" ? (
                    <span className="text-sm text-neutral-400">—</span>
                  ) : (
                    <button
                      type="button"
                      className="text-sm text-status-error-700 hover:underline disabled:opacity-50"
                      disabled={end.isPending}
                      onClick={() => {
                        const ok = window.confirm(
                          `End this partner's assignment on "${a.title}"? They lose access to the role and can't submit new candidates. Existing claims are untouched.`,
                        );
                        if (!ok) return;
                        end.mutate({ assignmentId: a.assignmentId });
                      }}
                    >
                      End assignment
                    </button>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-neutral-900">Assign a requisition</h3>
        {requisitionOptions === null ? (
          <p className="mt-1 text-xs text-neutral-600">
            The requisition list isn&apos;t readable with your roles, so the picker is unavailable
            here. An administrator can make the assignment.
          </p>
        ) : (
          <>
            <p className="mb-4 mt-1 text-xs text-neutral-600">
              Approved, posted and on-hold requisitions are offered. Assigning one makes it visible
              in this partner&apos;s portal so they can submit candidates against it.
            </p>
            {options.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No requisitions are available to assign — every open one is already with this
                partner, or none are open yet.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Select
                  className="min-w-[18rem]"
                  label="Requisition"
                  options={options}
                  value={selected}
                  onValueChange={setSelected}
                  placeholder="Choose a requisition"
                />
                <Button
                  onClick={() => {
                    setError(null);
                    assign.mutate({ partnerOrgId, requisitionId: selected });
                  }}
                  disabled={!selected || assign.isPending}
                >
                  {assign.isPending ? "Assigning…" : "Assign"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
