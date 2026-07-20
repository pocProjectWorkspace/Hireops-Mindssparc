"use client";

import { useMemo, useState } from "react";
import {
  type SystemSetup,
  type SystemAlertType,
  type EscalationSeverity,
  type EscalationRule,
  SYSTEM_ALERT_TYPES,
  SYSTEM_ALERT_TYPE_META,
  ESCALATION_SEVERITIES,
} from "@hireops/api-types";
import { Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin System Setup (AD14 / AD15). Two honest tabs — Email Alerts and simple
 * Escalation Rules — persisted as one updateSystemSetup mutation (admin-only,
 * audited, merged into tenants.settings.systemSetup alongside — never over —
 * aiSettings / biasLexicon / scoringWeights).
 *
 * The SLA hours themselves are NOT edited here: they stay hardcoded in
 * @hireops/sla-thresholds. This screen only configures who gets alerted and a
 * simple days→recipient→severity escalation. The full tenant-configurable SLA
 * table is Phase-3 deferred, and the SLA engine is untouched.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

type Tab = "alerts" | "escalation";

export function SystemSetupClient({ initial }: { initial: SystemSetup }) {
  const [tab, setTab] = useState<Tab>("alerts");

  const [enabled, setEnabled] = useState(initial.emailAlerts.enabled);
  const [recipientsText, setRecipientsText] = useState(initial.emailAlerts.recipients.join(", "));
  const [alertTypes, setAlertTypes] = useState<SystemAlertType[]>(initial.emailAlerts.alertTypes);
  const [rules, setRules] = useState<EscalationRule[]>(initial.escalationRules);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipients = useMemo(
    () =>
      recipientsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [recipientsText],
  );

  const invalidRecipients = recipients.filter((r) => !isEmail(r));
  const invalidRules = rules.filter((r) => !isEmail(r.recipient) || r.daysThreshold < 1);

  const baseline = useMemo(() => JSON.stringify(normalize(initial)), [initial]);
  const current = JSON.stringify(
    normalize({
      version: 1,
      emailAlerts: { enabled, recipients, alertTypes },
      escalationRules: rules,
    }),
  );
  const dirty = current !== baseline;

  const update = trpc.updateSystemSetup.useMutation({
    onSuccess: (res) => {
      const s = res.systemSetup;
      setEnabled(s.emailAlerts.enabled);
      setRecipientsText(s.emailAlerts.recipients.join(", "));
      setAlertTypes(s.emailAlerts.alertTypes);
      setRules(s.escalationRules);
      setError(null);
      setNotice("System setup saved.");
    },
    onError: (err) => {
      setNotice(null);
      setError(`Save failed: ${err.message}`);
    },
  });

  function onSave() {
    if (invalidRecipients.length > 0) {
      setError(`Not a valid email: ${invalidRecipients.join(", ")}`);
      return;
    }
    if (invalidRules.length > 0) {
      setError("Every escalation rule needs a valid recipient email and a day threshold ≥ 1.");
      return;
    }
    setError(null);
    update.mutate({
      version: 1,
      emailAlerts: { enabled, recipients, alertTypes },
      escalationRules: rules,
    });
  }

  function toggleAlertType(t: SystemAlertType) {
    setAlertTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  function addRule() {
    setRules((cur) => [...cur, { daysThreshold: 3, recipient: "", severity: "medium" }]);
  }

  function patchRule(i: number, patch: Partial<EscalationRule>) {
    setRules((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4">
        <p className="text-sm text-neutral-700">
          Operational configuration for this tenant. Alerts and escalations send over the real email
          path (Resend behind config). SLA <em>thresholds</em> themselves stay fixed in the platform
          defaults — this screen configures who gets notified, not the hours.
        </p>
      </div>

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-positive-200 bg-status-positive-50 px-4 py-3 text-sm text-status-positive-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="mb-5 flex gap-1 border-b border-neutral-200">
        <TabButton active={tab === "alerts"} onClick={() => setTab("alerts")}>
          Email Alerts
        </TabButton>
        <TabButton active={tab === "escalation"} onClick={() => setTab("escalation")}>
          Escalation Rules
        </TabButton>
      </div>

      {tab === "alerts" ? (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                aria-label="Send operational email alerts"
                className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                <span className="block text-sm font-semibold text-neutral-900">
                  Send operational email alerts
                </span>
                <span className="block text-xs text-neutral-500">
                  When off, nothing is sent regardless of the recipients or types below.
                </span>
              </span>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="mb-1 text-sm font-semibold text-neutral-900">Recipients</h3>
            <p className="mb-3 text-xs text-neutral-500">
              Comma-separated email addresses. These receive every enabled alert type.
            </p>
            <input
              className={inputCls}
              value={recipientsText}
              onChange={(e) => setRecipientsText(e.target.value)}
              placeholder="ops@example.com, oncall@example.com"
              aria-label="Alert recipients"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {recipients.map((r) => (
                <Badge key={r} tone={isEmail(r) ? "neutral" : "error"}>
                  {r}
                </Badge>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="mb-1 text-sm font-semibold text-neutral-900">Alert types</h3>
            <p className="mb-3 text-xs text-neutral-500">
              Each maps to a real platform event. Choose which ones page the recipients.
            </p>
            <div className="space-y-2">
              {SYSTEM_ALERT_TYPES.map((t) => (
                <div
                  key={t}
                  className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3"
                >
                  <input
                    type="checkbox"
                    checked={alertTypes.includes(t)}
                    onChange={() => toggleAlertType(t)}
                    aria-label={SYSTEM_ALERT_TYPE_META[t].label}
                    className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>
                    <span className="block text-sm font-medium text-neutral-800">
                      {SYSTEM_ALERT_TYPE_META[t].label}
                    </span>
                    <span className="block text-xs text-neutral-500">
                      {SYSTEM_ALERT_TYPE_META[t].description}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">Escalation rules</h3>
                <p className="text-xs text-neutral-500">
                  After a record sits N days, notify a recipient at the chosen severity. A simple,
                  deterministic rule — it does not change any SLA threshold.
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 text-xs text-brand-600 hover:underline"
                onClick={addRule}
                disabled={rules.length >= 10}
              >
                + Add rule
              </button>
            </div>

            {rules.length === 0 ? (
              <p className="text-xs text-neutral-500">
                No escalation rules. Add one to notify someone when work stalls past a threshold.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  <span className="col-span-3">After (days)</span>
                  <span className="col-span-5">Notify (email)</span>
                  <span className="col-span-3">Severity</span>
                  <span className="col-span-1" />
                </div>
                {rules.map((r, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-12 items-center gap-2 rounded-lg border border-neutral-200 p-2"
                  >
                    <div className="col-span-3">
                      <input
                        type="number"
                        min={1}
                        max={90}
                        className={inputCls}
                        value={r.daysThreshold}
                        onChange={(e) =>
                          patchRule(i, {
                            daysThreshold: clampDays(Number(e.target.value)),
                          })
                        }
                      />
                    </div>
                    <div className="col-span-5">
                      <input
                        className={inputCls}
                        value={r.recipient}
                        placeholder="lead@example.com"
                        onChange={(e) => patchRule(i, { recipient: e.target.value.trim() })}
                      />
                    </div>
                    <div className="col-span-3">
                      <select
                        className={inputCls}
                        value={r.severity}
                        onChange={(e) =>
                          patchRule(i, { severity: e.target.value as EscalationSeverity })
                        }
                      >
                        {ESCALATION_SEVERITIES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <button
                        type="button"
                        className="text-xs text-status-error-600 hover:underline"
                        onClick={() => setRules((cur) => cur.filter((_, idx) => idx !== i))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onSave} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save system setup"}
        </Button>
        {dirty ? (
          <button
            type="button"
            className="text-sm text-neutral-600 hover:underline"
            onClick={() => {
              setEnabled(initial.emailAlerts.enabled);
              setRecipientsText(initial.emailAlerts.recipients.join(", "));
              setAlertTypes(initial.emailAlerts.alertTypes);
              setRules(initial.escalationRules);
              setError(null);
              setNotice(null);
            }}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-brand-600 text-brand-700"
          : "border-transparent text-neutral-500 hover:text-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function clampDays(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(90, Math.round(n)));
}

/** Normalise for dirty-comparison — sort recipients + alert types so ordering
 * differences don't read as edits. */
function normalize(s: SystemSetup): unknown {
  return {
    enabled: s.emailAlerts.enabled,
    recipients: [...s.emailAlerts.recipients].sort(),
    alertTypes: [...s.emailAlerts.alertTypes].sort(),
    rules: s.escalationRules,
  };
}
