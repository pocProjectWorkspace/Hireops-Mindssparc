"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PLATFORM_MODULE_KEYS,
  PLATFORM_MODULE_LABELS,
  TENANT_TIERS,
  type PlatformModuleKey,
  type StarterPackSummary,
  type TenantTier,
} from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

const inputCls = "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm";

/**
 * C1-F11 — the operator's create-tenant form: slug, display name, region,
 * tier, starter pack, module overrides (pack recommendation pre-ticked) and
 * the first tenant admin's email. Submitting runs provisioning and lands on
 * the tenant page, which shows the step-by-step progress (and Retry on failure).
 */
export function CreateTenantForm({ packs }: { packs: StarterPackSummary[] }) {
  const router = useRouter();
  const [packKey, setPackKey] = useState(packs[0]?.key ?? "blank");
  const pack = packs.find((p) => p.key === packKey);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [region, setRegion] = useState(pack?.defaultRegion ?? "ap-south-1");
  const [tier, setTier] = useState<TenantTier>("standard");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [overrides, setOverrides] = useState<Partial<Record<PlatformModuleKey, boolean>>>({});
  const [error, setError] = useState<string | null>(null);

  const recommended = useMemo(
    () =>
      Object.fromEntries(PLATFORM_MODULE_KEYS.map((k) => [k, pack?.modules[k] ?? true])) as Record<
        PlatformModuleKey,
        boolean
      >,
    [pack],
  );
  const effective = (k: PlatformModuleKey) => overrides[k] ?? recommended[k];

  const create = trpc.platformCreateTenant.useMutation({
    onSuccess: (r) => router.push(`/platform/tenants/${r.tenantId}`),
    onError: (e) =>
      setError(
        e.message === "slug_taken"
          ? "That slug is already in use."
          : e.message === "unknown_pack"
            ? "Unknown starter pack."
            : e.message,
      ),
  });

  const modules = PLATFORM_MODULE_KEYS.filter((k) => overrides[k] !== undefined).map((k) => ({
    key: k,
    enabled: Boolean(overrides[k]),
  }));

  return (
    <form
      className="grid gap-6 lg:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        create.mutate({
          slug: slug.trim(),
          displayName: displayName.trim(),
          primaryRegion: region.trim(),
          tier,
          starterPack: packKey,
          modules,
          adminEmail: adminEmail.trim(),
          ...(adminName.trim() ? { adminDisplayName: adminName.trim() } : {}),
        });
      }}
    >
      <Card>
        <h2 className="mb-3 text-sm font-semibold">Tenant</h2>
        <div className="flex flex-col gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">Display name</span>
            <input
              className={inputCls}
              required
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">
              Slug (lower-case letters, digits, hyphens; used in candidate links)
            </span>
            <input
              className={inputCls}
              required
              minLength={3}
              maxLength={40}
              pattern="[a-z0-9-]+"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">Data region</span>
            <input
              className={inputCls}
              required
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">Tier</span>
            <select
              className={inputCls}
              value={tier}
              onChange={(e) => setTier(e.target.value as TenantTier)}
            >
              {TENANT_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">First tenant admin — email</span>
            <input
              className={inputCls}
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">
              First tenant admin — name (optional)
            </span>
            <input
              className={inputCls}
              maxLength={120}
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
            />
          </label>
          <p className="text-xs text-neutral-500">
            The admin receives an invitation email to set a password. An address that already has a
            HireOps login gets the new organisation added to that login instead (no email).
          </p>
        </div>
      </Card>

      <div className="flex flex-col gap-6">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Starter pack</h2>
          <div className="flex flex-col gap-2">
            {packs.map((p) => (
              <label
                key={p.key}
                className="flex gap-2 rounded-md border border-neutral-200 p-2 text-sm"
              >
                <input
                  type="radio"
                  name="pack"
                  checked={p.key === packKey}
                  onChange={() => {
                    setPackKey(p.key);
                    setOverrides({});
                    setRegion(p.defaultRegion);
                  }}
                />
                <span>
                  <span className="font-medium">{p.label}</span>{" "}
                  <span className="text-xs text-neutral-500">v{p.version}</span>
                  <span className="block text-xs text-neutral-600">{p.description}</span>
                  {Object.keys(p.contents).length > 0 ? (
                    <span className="block text-xs text-neutral-500">
                      {Object.entries(p.contents)
                        .map(([k, n]) => `${k}: ${n}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Modules</h2>
          <p className="mb-2 text-xs text-neutral-500">
            Pre-ticked from the pack. Changes are recorded as overrides.
          </p>
          <ul className="divide-y divide-neutral-100">
            {PLATFORM_MODULE_KEYS.map((k) => (
              <li key={k} className="flex items-center justify-between py-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={effective(k)}
                    onChange={(e) =>
                      setOverrides((o) => {
                        const rest = Object.fromEntries(
                          Object.entries(o).filter(([key]) => key !== k),
                        ) as Partial<Record<PlatformModuleKey, boolean>>;
                        return e.target.checked === recommended[k]
                          ? rest
                          : { ...rest, [k]: e.target.checked };
                      })
                    }
                  />
                  <span>{PLATFORM_MODULE_LABELS[k]}</span>
                </label>
                {overrides[k] !== undefined ? (
                  <span className="text-xs text-status-info-800">override</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Provisioning…" : "Create tenant"}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-status-error-700">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
