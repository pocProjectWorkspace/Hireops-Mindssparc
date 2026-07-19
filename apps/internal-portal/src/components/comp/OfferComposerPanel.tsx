"use client";

import { useState } from "react";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button } from "@/components/ui";
import {
  BENEFIT_KEYS,
  BENEFIT_META,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  type BenefitKey,
  type ContractType,
} from "@hireops/api-types";

/**
 * OfferComposerPanel (HROPS-02) — the per-application offer composer, exported
 * as a standalone panel so the desk drawer AND (at reconciliation) the
 * case-detail Offer tab can both mount it. Drafts via the HROPS-02
 * draftCompOffer mutation (contract type / probation / benefits on top of the
 * existing offer lifecycle); "Send offer" chains the existing extendOffer flow
 * (email + signed link) UNLESS the base is out-of-band, in which case it saves
 * the draft and routes to approval instead of extending.
 *
 * Money boundary: rupees in the form → paise on the wire.
 */

export interface OfferComposerPanelProps {
  applicationId: string;
  /** Rule-engine suggestion in paise — pre-fills the base field as rupees. */
  suggestedPaise?: number | null;
  /** Called after a successful draft / send so the parent can refetch. */
  onSaved?: () => void;
  /** Called to leave composer mode (back to analysis). */
  onCancel?: () => void;
}

export function OfferComposerPanel({
  applicationId,
  suggestedPaise,
  onSaved,
  onCancel,
}: OfferComposerPanelProps) {
  const draft = trpc.draftCompOffer.useMutation();
  const extend = trpc.extendOffer.useMutation();
  const requestApproval = trpc.requestOfferApproval.useMutation();

  const suggestedRupees = suggestedPaise != null ? String(Math.round(suggestedPaise / 100)) : "";
  const [baseInr, setBaseInr] = useState(suggestedRupees);
  const [variableInr, setVariableInr] = useState("");
  const [bonusInr, setBonusInr] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [location, setLocation] = useState("Bengaluru (Hybrid)");
  const [contractType, setContractType] = useState<ContractType>("full_time");
  const [probationMonths, setProbationMonths] = useState(3);
  const [expiryDays, setExpiryDays] = useState(7);
  const [benefits, setBenefits] = useState<BenefitKey[]>(["health_insurance", "provident_fund"]);
  const [termsHtml, setTermsHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const baseInrInt = parseInt(baseInr, 10);
  const canSubmit =
    Number.isFinite(baseInrInt) && baseInrInt > 0 && joiningDate.length > 0 && location.length > 0;
  const busy = draft.isPending || extend.isPending || requestApproval.isPending;

  function toggleBenefit(k: BenefitKey) {
    setBenefits((prev) => (prev.includes(k) ? prev.filter((b) => b !== k) : [...prev, k]));
  }

  async function createDraft(): Promise<{ offerId: string; needsApproval: boolean } | null> {
    setError(null);
    setNotice(null);
    try {
      return await draft.mutateAsync({
        applicationId,
        baseSalaryInrPaise: baseInrInt * 100,
        variableTargetInrPaise: variableInr ? Number(variableInr) * 100 : undefined,
        joiningBonusInrPaise: bonusInr ? Number(bonusInr) * 100 : undefined,
        joiningDate,
        location,
        contractType,
        probationMonths,
        benefits,
        expiryDays,
        termsHtml: termsHtml || undefined,
      });
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
      return null;
    }
  }

  async function onSaveDraft() {
    if (!canSubmit) return;
    const res = await createDraft();
    if (res) {
      setNotice(
        res.needsApproval
          ? "Draft saved. This offer is out-of-band — request HR-head approval before sending."
          : "Draft saved.",
      );
      onSaved?.();
    }
  }

  async function onSendOffer() {
    if (!canSubmit) return;
    const res = await createDraft();
    if (!res) return;
    if (res.needsApproval) {
      // Out-of-band — don't extend; raise the approval instead.
      try {
        await requestApproval.mutateAsync({ offerId: res.offerId });
        setNotice(
          "Out-of-band offer saved and sent for HR-head approval. It can be extended once approved.",
        );
      } catch (err) {
        handleTRPCError(err, { onMessage: (m) => setError(m) });
      }
      onSaved?.();
      return;
    }
    try {
      await extend.mutateAsync({ offerId: res.offerId });
      setNotice("Offer sent — the candidate has an email with a signed accept link.");
      onSaved?.();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumField label="Base salary (INR / year)" value={baseInr} onChange={setBaseInr} required />
        <NumField
          label="Variable target (INR / year)"
          value={variableInr}
          onChange={setVariableInr}
        />
        <NumField label="Joining bonus (INR)" value={bonusInr} onChange={setBonusInr} />
        <DateField label="Joining date" value={joiningDate} onChange={setJoiningDate} />
        <TextField label="Location" value={location} onChange={setLocation} />
        <SelectField
          label="Contract type"
          value={contractType}
          onChange={(v) => setContractType(v as ContractType)}
          options={CONTRACT_TYPES.map((c) => ({ value: c, label: CONTRACT_TYPE_LABELS[c] }))}
        />
        <NumField
          label="Probation (months)"
          value={String(probationMonths)}
          onChange={(v) => setProbationMonths(Math.max(0, parseInt(v, 10) || 0))}
        />
        <NumField
          label="Offer expiry (days)"
          value={String(expiryDays)}
          onChange={(v) => setExpiryDays(Math.max(1, parseInt(v, 10) || 7))}
        />
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-neutral-700">Benefits</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {BENEFIT_KEYS.map((k) => (
            <label
              key={k}
              aria-label={BENEFIT_META[k].label}
              className="flex items-start gap-2 text-sm text-neutral-700"
            >
              <input
                type="checkbox"
                checked={benefits.includes(k)}
                onChange={() => toggleBenefit(k)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-neutral-800">{BENEFIT_META[k].label}</span>
                <span className="block text-[11px] text-neutral-500">
                  {BENEFIT_META[k].description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block">
        <span className="text-xs font-medium text-neutral-700">Terms / boilerplate</span>
        <textarea
          value={termsHtml}
          onChange={(e) => setTermsHtml(e.target.value)}
          rows={4}
          className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
          placeholder="Standard at-will employment, confidentiality, etc."
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={!canSubmit || busy} onClick={onSendOffer}>
          {busy ? "Working…" : "Send offer"}
        </Button>
        <Button variant="secondary" size="sm" disabled={!canSubmit || busy} onClick={onSaveDraft}>
          Save draft
        </Button>
        {onCancel ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {notice ? <p className="text-xs text-status-positive-700">{notice}</p> : null}
      {error ? <p className="text-xs text-status-error-700">{error}</p> : null}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
      />
    </label>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-neutral-300 bg-white p-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
