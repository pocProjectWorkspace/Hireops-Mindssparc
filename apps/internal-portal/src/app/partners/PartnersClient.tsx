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
    </PageContainer>
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
