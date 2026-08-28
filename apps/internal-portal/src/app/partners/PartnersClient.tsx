"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ListPartnerOrgsOutput,
  PartnerOrgSummary,
  PartnerTierValue,
} from "@hireops/api-types";
import { Input, Select, Button } from "@hireops/ui";
import { Card, Badge, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { PageHeader } from "@/components/patterns";
import { trpc } from "@/lib/trpc-client";

/**
 * P0.1B — partner-organisation index + the empanelment form.
 *
 * The three counts on each row (users / active assignments / active claims)
 * come straight from listPartnerOrgs; nothing here is derived client-side, so
 * a zero is an honest zero. The row opens the org's detail surface, where the
 * invitation and assignment lifecycles live.
 *
 * "Empanel partner" is deliberately an inline card rather than a modal: it is
 * a rare, deliberate administrative act and the list underneath is the context
 * an operator wants while typing (is this partner already here?).
 */

const TIER_OPTIONS = [
  { value: "empanelled", label: "Empanelled" },
  { value: "ad_hoc", label: "Ad hoc" },
];

export function tierLabel(tier: PartnerTierValue): string {
  return tier === "empanelled" ? "Empanelled" : "Ad hoc";
}

/** ISO → "07 Jul 2026". Null stays an em dash — we never invent a date. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function PartnersClient({ initial }: { initial: ListPartnerOrgsOutput }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.listPartnerOrgs.useQuery(undefined, {
    initialData: initial,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
  const orgs = query.data?.items ?? initial.items;

  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const activeCount = useMemo(() => orgs.filter((o) => o.active).length, [orgs]);

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Partner organisations"
        subtitle={
          orgs.length === 0
            ? "Staffing partners empanelled on this tenant."
            : `${orgs.length} partner${orgs.length === 1 ? "" : "s"}, ${activeCount} active.`
        }
        right={
          <Button
            variant={formOpen ? "secondary" : "primary"}
            onClick={() => setFormOpen((v) => !v)}
          >
            {formOpen ? "Close" : "Empanel partner"}
          </Button>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}

      {formOpen ? (
        <EmpanelPartnerForm
          onCreated={(name, partnerOrgId) => {
            setFormOpen(false);
            setNotice(`${name} is empanelled. Invite its first portal user from the org page.`);
            void utils.listPartnerOrgs.invalidate();
            router.push(`/partners/${partnerOrgId}`);
          }}
          onCancel={() => setFormOpen(false)}
        />
      ) : null}

      {orgs.length === 0 ? (
        <Card>
          <EmptyState
            title="No partner organisations yet"
            hint="Empanel a staffing partner to give it portal access, then assign it requisitions to source against."
            action={<Button onClick={() => setFormOpen(true)}>Empanel partner</Button>}
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Partner</Th>
            <Th>Tier</Th>
            <Th>Country</Th>
            <Th>Status</Th>
            <Th numeric>Users</Th>
            <Th numeric>Assignments</Th>
            <Th numeric>Claims</Th>
            <Th>Onboarded</Th>
          </Thead>
          <Tbody>
            {orgs.map((org) => (
              <PartnerRow
                key={org.partnerOrgId}
                org={org}
                onOpen={() => router.push(`/partners/${org.partnerOrgId}`)}
              />
            ))}
          </Tbody>
        </TableShell>
      )}

      <PartnerDefaultsCard />
    </PageContainer>
  );
}

/**
 * A3 — the one tenant-level partner default: the ownership-claim exclusivity
 * window used for orgs that have NO live MSA. Deliberately a modest card at the
 * foot of the index rather than its own admin page: it is a single number, and
 * the per-org terms that override it live on each org's Commercials tab.
 *
 * No extra role gate here — /partners is already gated to admin / hr_ops by the
 * page (READ_ROLES in page.tsx), which is the same PARTNER_ADMIN_ROLES set
 * get/updatePartnerDefaults enforce server-side.
 */
function PartnerDefaultsCard() {
  const utils = trpc.useUtils();
  const query = trpc.getPartnerDefaults.useQuery({}, { refetchOnWindowFocus: false });

  // `draft` is null until the operator types, so the field prefills from the
  // query the moment it lands without an effect, and an in-progress edit is
  // never clobbered by a refetch.
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saved = query.data?.claimWindowDays ?? null;
  const value = draft ?? (saved === null ? "" : String(saved));
  const parsed = Number(value.trim());
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= 365;
  const dirty = saved !== null && value.trim() !== String(saved);

  const update = trpc.updatePartnerDefaults.useMutation({
    onSuccess: async (res) => {
      setDraft(null);
      setError(null);
      setNotice(
        `Saved. Partners without an MSA now get a ${res.partnerDefaults.claimWindowDays}-day claim window on their next submission.`,
      );
      await utils.getPartnerDefaults.invalidate();
    },
    onError: (err) => {
      setNotice(null);
      setError(err.message);
    },
  });

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-neutral-900">Partner defaults</h2>
      <p className="mb-4 mt-1 text-xs text-neutral-600">
        Applies to partners with no agreed MSA. Where an organisation has live terms, its MSA&apos;s
        exclusivity window wins — set that on the organisation&apos;s Commercials tab. Changing this
        affects future submissions only; claims already made keep the window they were granted.
      </p>

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <Input
          className="w-72"
          label="Claim window for partners without an MSA (days)"
          type="number"
          min={1}
          max={365}
          value={value}
          disabled={query.isLoading}
          onChange={(e) => {
            setDraft(e.target.value);
            setNotice(null);
            setError(null);
          }}
          error={
            value.trim() !== "" && !valid ? "Enter a whole number of days, 1 to 365." : undefined
          }
          hint="Between 1 and 365 days. Default 90."
        />
        <Button
          onClick={() => {
            if (!valid) return;
            setNotice(null);
            setError(null);
            update.mutate({ claimWindowDays: parsed });
          }}
          disabled={!valid || !dirty || update.isPending || query.isLoading}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

function PartnerRow({ org, onOpen }: { org: PartnerOrgSummary; onOpen: () => void }) {
  return (
    <Tr onClick={onOpen} className="cursor-pointer">
      <Td className="font-medium text-neutral-900">
        <span className="block">{org.name}</span>
        {org.legalEntityName && org.legalEntityName !== org.name ? (
          <span className="block text-xs text-neutral-500">{org.legalEntityName}</span>
        ) : null}
        {org.primaryContactEmail ? (
          <span className="block text-xs text-neutral-500">{org.primaryContactEmail}</span>
        ) : null}
      </Td>
      <Td label="Tier">
        <Badge tone={org.tier === "empanelled" ? "accent" : "neutral"}>{tierLabel(org.tier)}</Badge>
      </Td>
      <Td label="Country">{org.country ?? "—"}</Td>
      <Td label="Status">
        <Badge tone={org.active ? "success" : "neutral"}>
          {org.active ? "Active" : "Suspended"}
        </Badge>
      </Td>
      <Td numeric label="Users">
        {org.userCount}
      </Td>
      <Td numeric label="Assignments">
        {org.activeAssignmentCount}
      </Td>
      <Td numeric label="Claims">
        {org.activeClaimCount}
      </Td>
      <Td label="Onboarded">{fmtDate(org.onboardedAt)}</Td>
    </Tr>
  );
}

/**
 * Empanelment form. Mirrors createPartnerOrgInputSchema exactly: name + tier +
 * primaryContactEmail are required, phone and country optional, country is the
 * ISO-3166-1 alpha-2 code partner_orgs.country (char(2)) stores.
 */
function EmpanelPartnerForm({
  onCreated,
  onCancel,
}: {
  onCreated: (name: string, partnerOrgId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<PartnerTierValue>("empanelled");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = trpc.createPartnerOrg.useMutation({
    onSuccess: (res) => onCreated(name.trim(), res.partnerOrgId),
    onError: (err) => setError(err.message),
  });

  const trimmedCountry = country.trim().toUpperCase();
  const countryOk = trimmedCountry.length === 0 || trimmedCountry.length === 2;
  const canSubmit =
    name.trim().length > 0 && email.trim().length > 0 && countryOk && !create.isPending;

  function submit() {
    setError(null);
    create.mutate({
      name: name.trim(),
      tier,
      primaryContactEmail: email.trim(),
      ...(phone.trim() ? { primaryContactPhone: phone.trim() } : {}),
      ...(trimmedCountry ? { country: trimmedCountry } : {}),
    });
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-neutral-900">Empanel a partner</h2>
      <p className="mb-4 mt-1 text-xs text-neutral-600">
        Creates the organisation as active. It gets no portal access until you invite its first
        user, and no visibility of any role until you assign it a requisition.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Partner name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Talent Bridge Staffing"
        />
        <Select
          label="Tier"
          options={TIER_OPTIONS}
          value={tier}
          onValueChange={(v) => setTier(v as PartnerTierValue)}
          hint="Empanelled partners are on a standing agreement; ad hoc are engaged per requisition."
        />
        <Input
          label="Primary contact email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="accounts@partner.example"
        />
        <Input
          label="Primary contact phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          hint="Optional."
        />
        <Input
          label="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder="IN"
          maxLength={2}
          error={countryOk ? undefined : "Use the two-letter ISO country code, e.g. IN or DE."}
          hint="Optional. Two-letter ISO code."
        />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button onClick={submit} disabled={!canSubmit}>
          {create.isPending ? "Empanelling…" : "Empanel partner"}
        </Button>
        <button
          type="button"
          className="text-sm text-neutral-600 hover:underline"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}
