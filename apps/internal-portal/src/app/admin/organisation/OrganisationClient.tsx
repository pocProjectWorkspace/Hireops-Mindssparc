"use client";

import { useMemo, useState } from "react";
import {
  locationDisplay,
  type GetOrgAndJobArchitectureOutput,
  type LegalEntityRow,
  type LocationRow,
} from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Organisation (C1-F3 — Plan A §15 P1): legal entity → country →
 * business unit → location, inside one tenant.
 *
 *   - Legal entities: name + ISO country, deactivate (never delete).
 *   - Locations: name, city, region / state, country, owning entity, IANA
 *     time zone. Requisitions pick from the active list; the old free-text
 *     location stays as the display fallback.
 *   - Business units ↔ entity: which entity each unit belongs to (units
 *     themselves are managed on the Business units page).
 *
 * hr_head sees the page read-only (canEdit false); the server enforces the
 * admin-only writes too.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-50";
const labelCls = "mb-1 block text-xs font-medium text-neutral-700";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
      {children}
    </span>
  );
}

interface LocationForm {
  name: string;
  city: string;
  region: string;
  countryCode: string;
  legalEntityId: string;
  timezone: string;
  isActive: boolean;
}

const EMPTY_LOCATION: LocationForm = {
  name: "",
  city: "",
  region: "",
  countryCode: "",
  legalEntityId: "",
  timezone: "",
  isActive: true,
};

function locationForm(l: LocationRow): LocationForm {
  return {
    name: l.name,
    city: l.city ?? "",
    region: l.region ?? "",
    countryCode: l.countryCode,
    legalEntityId: l.legalEntityId ?? "",
    timezone: l.timezone ?? "",
    isActive: l.isActive,
  };
}

function locationPayload(f: LocationForm) {
  return {
    name: f.name.trim(),
    city: f.city.trim() || null,
    region: f.region.trim() || null,
    countryCode: f.countryCode.trim(),
    legalEntityId: f.legalEntityId || null,
    timezone: f.timezone.trim() || null,
  };
}

export function OrganisationClient({
  initial,
  canEdit,
}: {
  initial: GetOrgAndJobArchitectureOutput;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const query = trpc.getOrgAndJobArchitecture.useQuery(
    { includeInactive: true },
    { initialData: initial },
  );
  const data = query.data ?? initial;
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const entityName = useMemo(() => {
    const m = new Map(data.legalEntities.map((e) => [e.id, e.name] as const));
    return (id: string | null) => (id ? (m.get(id) ?? "Unknown entity") : null);
  }, [data.legalEntities]);

  async function refresh(text: string) {
    await utils.getOrgAndJobArchitecture.invalidate();
    setNotice({ ok: true, text });
  }
  const onError = (err: unknown) => {
    setNotice({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    handleTRPCError(err, { onMessage: () => undefined });
  };

  // ── legal entities ──
  const [entityDraft, setEntityDraft] = useState({ name: "", countryCode: "" });
  const [editEntity, setEditEntity] = useState<LegalEntityRow | null>(null);
  const createEntity = trpc.createLegalEntity.useMutation({
    onSuccess: async (r) => {
      setEntityDraft({ name: "", countryCode: "" });
      await refresh(`Added “${r.row.name}”.`);
    },
    onError,
  });
  const updateEntity = trpc.updateLegalEntity.useMutation({
    onSuccess: async (r) => {
      setEditEntity(null);
      await refresh(`Saved “${r.row.name}”.`);
    },
    onError,
  });

  // ── locations ──
  const [locDraft, setLocDraft] = useState<LocationForm>(EMPTY_LOCATION);
  const [editLocId, setEditLocId] = useState<string | null>(null);
  const [editLoc, setEditLoc] = useState<LocationForm>(EMPTY_LOCATION);
  const createLocation = trpc.createLocation.useMutation({
    onSuccess: async (r) => {
      setLocDraft(EMPTY_LOCATION);
      await refresh(`Added “${r.row.name}”.`);
    },
    onError,
  });
  const updateLocation = trpc.updateLocation.useMutation({
    onSuccess: async (r) => {
      setEditLocId(null);
      await refresh(`Saved “${r.row.name}”.`);
    },
    onError,
  });

  // ── BU ↔ entity ──
  const setBuEntity = trpc.setBusinessUnitLegalEntity.useMutation({
    onSuccess: async (r) => refresh(`Updated “${r.row.name}”.`),
    onError,
  });

  const busy =
    createEntity.isPending ||
    updateEntity.isPending ||
    createLocation.isPending ||
    updateLocation.isPending ||
    setBuEntity.isPending;

  const activeEntities = data.legalEntities.filter((e) => e.isActive);

  function locationFields(f: LocationForm, set: (f: LocationForm) => void) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input
            className={inputCls}
            value={f.name}
            maxLength={160}
            onChange={(e) => set({ ...f, name: e.target.value })}
          />
        </Field>
        <Field label="City">
          <input
            className={inputCls}
            value={f.city}
            maxLength={120}
            onChange={(e) => set({ ...f, city: e.target.value })}
          />
        </Field>
        <Field label="Region / state">
          <input
            className={inputCls}
            value={f.region}
            maxLength={120}
            onChange={(e) => set({ ...f, region: e.target.value })}
          />
        </Field>
        <Field label="Country (ISO code)">
          <input
            className={inputCls}
            value={f.countryCode}
            maxLength={2}
            placeholder="e.g. IN"
            onChange={(e) => set({ ...f, countryCode: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Legal entity (optional)">
          <select
            className={inputCls}
            value={f.legalEntityId}
            onChange={(e) => set({ ...f, legalEntityId: e.target.value })}
          >
            <option value="">— None —</option>
            {data.legalEntities
              .filter((e) => e.isActive || e.id === f.legalEntityId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.countryCode})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Time zone (IANA, optional)">
          <input
            className={inputCls}
            value={f.timezone}
            maxLength={64}
            placeholder="e.g. Asia/Kolkata"
            onChange={(e) => set({ ...f, timezone: e.target.value })}
          />
        </Field>
      </div>
    );
  }

  const locationValid = (f: LocationForm) =>
    f.name.trim().length > 0 && /^[A-Z]{2}$/.test(f.countryCode.trim());

  return (
    <PageContainer>
      <PageHeader
        title="Organisation"
        subtitle="Legal entities, work locations and which entity each business unit belongs to. Requisitions pick from the active locations."
      />

      {!canEdit ? (
        <div className="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
          You can view the organisation. Changes are made by an administrator.
        </div>
      ) : null}

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.ok
              ? "border-status-success-200 bg-status-success-50 text-status-success-700"
              : "border-status-error-200 bg-status-error-50 text-status-error-700"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* ── Legal entities ── */}
      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-neutral-900">Legal entities</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The companies your organisation hires into. A new country or company is a new entity here,
          not a new tenant.
        </p>
        {canEdit ? (
          <div className="mt-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_8rem_auto]">
            <Field label="Name">
              <input
                className={inputCls}
                value={entityDraft.name}
                maxLength={160}
                onChange={(e) => setEntityDraft({ ...entityDraft, name: e.target.value })}
              />
            </Field>
            <Field label="Country (ISO)">
              <input
                className={inputCls}
                value={entityDraft.countryCode}
                maxLength={2}
                placeholder="IN"
                onChange={(e) =>
                  setEntityDraft({ ...entityDraft, countryCode: e.target.value.toUpperCase() })
                }
              />
            </Field>
            <Button
              disabled={
                busy ||
                entityDraft.name.trim().length === 0 ||
                !/^[A-Z]{2}$/.test(entityDraft.countryCode)
              }
              onClick={() =>
                createEntity.mutate({
                  name: entityDraft.name.trim(),
                  countryCode: entityDraft.countryCode,
                })
              }
            >
              Add entity
            </Button>
          </div>
        ) : null}
        {data.legalEntities.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No legal entities yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-100">
            {data.legalEntities.map((e) => (
              <li key={e.id} className="py-3">
                {editEntity?.id === e.id ? (
                  <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_8rem_auto_auto]">
                    <Field label="Name">
                      <input
                        className={inputCls}
                        value={editEntity.name}
                        maxLength={160}
                        onChange={(ev) => setEditEntity({ ...editEntity, name: ev.target.value })}
                      />
                    </Field>
                    <Field label="Country (ISO)">
                      <input
                        className={inputCls}
                        value={editEntity.countryCode}
                        maxLength={2}
                        onChange={(ev) =>
                          setEditEntity({
                            ...editEntity,
                            countryCode: ev.target.value.toUpperCase(),
                          })
                        }
                      />
                    </Field>
                    <Button
                      disabled={busy || !/^[A-Z]{2}$/.test(editEntity.countryCode)}
                      onClick={() =>
                        updateEntity.mutate({
                          id: editEntity.id,
                          name: editEntity.name.trim(),
                          countryCode: editEntity.countryCode,
                          isActive: editEntity.isActive,
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setEditEntity(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={
                          e.isActive
                            ? "font-medium text-neutral-900"
                            : "text-neutral-400 line-through"
                        }
                      >
                        {e.name}
                      </span>
                      <Pill>{e.countryCode}</Pill>
                      {!e.isActive ? <Pill>Inactive</Pill> : null}
                    </div>
                    {canEdit ? (
                      <div className="flex shrink-0 gap-3 text-sm">
                        <button
                          type="button"
                          className="font-medium text-brand-600 hover:underline"
                          onClick={() => setEditEntity(e)}
                          disabled={busy}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="font-medium text-neutral-600 hover:underline"
                          disabled={busy}
                          onClick={() =>
                            updateEntity.mutate({
                              id: e.id,
                              name: e.name,
                              countryCode: e.countryCode,
                              isActive: !e.isActive,
                            })
                          }
                        >
                          {e.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Locations ── */}
      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-neutral-900">Locations</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Country, region and city for each place you hire into. The requisition wizard&apos;s
          location picker reads the active ones; market data will key off them later.
        </p>
        {canEdit ? (
          <div className="mt-4 rounded-lg border border-neutral-200 p-4">
            {locationFields(locDraft, setLocDraft)}
            <div className="mt-3">
              <Button
                disabled={busy || !locationValid(locDraft)}
                onClick={() => createLocation.mutate(locationPayload(locDraft))}
              >
                Add location
              </Button>
            </div>
          </div>
        ) : null}
        {data.locations.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No locations yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-100">
            {data.locations.map((l) => (
              <li key={l.id} className="py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          l.isActive
                            ? "font-medium text-neutral-900"
                            : "text-neutral-400 line-through"
                        }
                      >
                        {locationDisplay(l)}
                      </span>
                      {!l.isActive ? <Pill>Inactive</Pill> : null}
                    </div>
                    <span className="mt-0.5 block text-xs text-neutral-500">
                      {[entityName(l.legalEntityId), l.timezone].filter(Boolean).join(" · ") ||
                        "No entity · tenant time zone"}
                    </span>
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 gap-3 text-sm">
                      <button
                        type="button"
                        className="font-medium text-brand-600 hover:underline"
                        disabled={busy}
                        onClick={() => {
                          setEditLocId(l.id);
                          setEditLoc(locationForm(l));
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="font-medium text-neutral-600 hover:underline"
                        disabled={busy}
                        onClick={() =>
                          updateLocation.mutate({
                            id: l.id,
                            ...locationPayload(locationForm(l)),
                            isActive: !l.isActive,
                          })
                        }
                      >
                        {l.isActive ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  ) : null}
                </div>
                {editLocId === l.id ? (
                  <div className="mt-3 rounded-lg border border-neutral-200 p-4">
                    {locationFields(editLoc, setEditLoc)}
                    <div className="mt-3 flex gap-3">
                      <Button
                        disabled={busy || !locationValid(editLoc)}
                        onClick={() =>
                          updateLocation.mutate({
                            id: l.id,
                            ...locationPayload(editLoc),
                            isActive: editLoc.isActive,
                          })
                        }
                      >
                        Save
                      </Button>
                      <Button variant="ghost" onClick={() => setEditLocId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Business units ↔ entity ── */}
      <Card className="mt-6 p-6">
        <h2 className="text-sm font-semibold text-neutral-900">Business units by legal entity</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Which legal entity each business unit belongs to. Units are added and renamed on the{" "}
          <a href="/admin/business-units" className="font-medium text-brand-600 hover:underline">
            Business units
          </a>{" "}
          page.
        </p>
        {data.businessUnits.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No business units yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-100">
            {data.businessUnits.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-4 py-2">
                <span
                  className={u.isArchived ? "text-neutral-400 line-through" : "text-neutral-900"}
                >
                  {u.name}
                </span>
                <div className="w-72">
                  {canEdit ? (
                    <select
                      className={inputCls}
                      value={u.legalEntityId ?? ""}
                      disabled={busy}
                      aria-label={`Legal entity for ${u.name}`}
                      onChange={(e) =>
                        setBuEntity.mutate({
                          businessUnitId: u.id,
                          legalEntityId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">— No entity —</option>
                      {activeEntities
                        .concat(
                          data.legalEntities.filter((e) => !e.isActive && e.id === u.legalEntityId),
                        )
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name} ({e.countryCode})
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="text-sm text-neutral-600">
                      {entityName(u.legalEntityId) ?? "No entity"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
