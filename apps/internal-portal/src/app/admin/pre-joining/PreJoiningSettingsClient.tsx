"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CLASSIFIER_SIGNAL_DEFINITIONS,
  PRE_JOINING_CADENCE_MAX,
  PRE_JOINING_CADENCE_MIN,
  PRE_JOINING_STEP_LABELS,
  RISK_SIGNAL_LABELS,
  RISK_SIGNAL_TYPES,
  type CompanyUpdateRow,
  type PreJoiningEngagementSettings,
  type RiskSignalType,
} from "@hireops/api-types";
import { Badge, Button, Card } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

const input = "h-9 rounded-md border border-neutral-200 px-2 text-sm";

const EMPTY = {
  id: null as string | null,
  title: "",
  body: "",
  linkUrl: "",
  videoUrl: "",
  isActive: true,
  sortOrder: 100,
};

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-neutral-500">{hint}</p> : null}
      </div>
      {children}
    </Card>
  );
}

export function PreJoiningSettingsClient({
  initialSettings,
  initialUpdates,
}: {
  initialSettings: PreJoiningEngagementSettings;
  initialUpdates: CompanyUpdateRow[];
}) {
  const utils = trpc.useUtils();
  const [s, setS] = useState<PreJoiningEngagementSettings>(initialSettings);
  const [msg, setMsg] = useState<string | null>(null);
  const updates = trpc.listPreJoiningCompanyUpdates.useQuery(
    {},
    { initialData: { items: initialUpdates } },
  );
  const save = trpc.updatePreJoiningSettings.useMutation({
    onSuccess: (r) => {
      setS(r.settings);
      setMsg("Saved.");
      void utils.getPreJoiningSettings.invalidate();
    },
    onError: (e) => handleTRPCError(e, { onMessage: setMsg }),
  });
  const start = trpc.startPreJoiningJourneys.useMutation({
    onSuccess: (r) => setMsg(`Started ${r.started} journey(s); ${r.skipped} not eligible.`),
    onError: (e) => handleTRPCError(e, { onMessage: setMsg }),
  });
  const upsert = trpc.upsertPreJoiningCompanyUpdate.useMutation({
    onSuccess: () => {
      setDraft(EMPTY);
      void utils.listPreJoiningCompanyUpdates.invalidate();
    },
    onError: (e) => handleTRPCError(e, { onMessage: setMsg }),
  });

  const [draft, setDraft] = useState(EMPTY);
  const [newReason, setNewReason] = useState("");

  const toggleSignal = (list: "enabled" | "alertOn", t: RiskSignalType) =>
    setS((p) => {
      const cur = new Set(p.signals[list]);
      if (cur.has(t)) cur.delete(t);
      else cur.add(t);
      return {
        ...p,
        signals: { ...p.signals, [list]: RISK_SIGNAL_TYPES.filter((x) => cur.has(x)) },
      };
    });

  return (
    <PageContainer variant="measure" className="space-y-4">
      <Section
        title="Engagement"
        hint="Keeps candidates warm between offer acceptance and their joining date: a welcome, regular one-question check-ins, company news, and countdown emails with first-day information. Off by default."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => setS({ ...s, enabled: e.target.checked })}
          />
          Send pre-joining engagement to candidates who accept an offer
        </label>
        <label className="flex items-center gap-2 text-sm">
          Check in every
          <input
            type="number"
            min={PRE_JOINING_CADENCE_MIN}
            max={PRE_JOINING_CADENCE_MAX}
            value={s.cadenceDays}
            onChange={(e) => setS({ ...s, cadenceDays: Number(e.target.value) })}
            className={`${input} w-20`}
          />
          days
        </label>
        <label className="block text-sm">
          <span className="text-neutral-700">
            Sender name (optional — the sending address stays the platform&apos;s)
          </span>
          <input
            value={s.senderName ?? ""}
            onChange={(e) =>
              setS({ ...s, senderName: e.target.value.trim() ? e.target.value : null })
            }
            className={`${input} mt-1 block w-full`}
            maxLength={80}
          />
        </label>
      </Section>

      <Section
        title="Steps"
        hint="Which emails the journey sends. Check-in emails carry the 'still on track?' link."
      >
        {s.steps.map((step, i) => (
          <label key={step.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={step.enabled}
              onChange={(e) =>
                setS({
                  ...s,
                  steps: s.steps.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)),
                })
              }
            />
            {PRE_JOINING_STEP_LABELS[step.key]}
            {step.key === "welcome_guide" ? (
              <Link href="/admin/welcome-content" className="text-xs text-brand-700 underline">
                Manage welcome content
              </Link>
            ) : null}
          </label>
        ))}
        <label className="block text-sm">
          <span className="text-neutral-700">
            First-day information (shown in the “one week to go” email)
          </span>
          <textarea
            value={s.firstDayInfo}
            onChange={(e) => setS({ ...s, firstDayInfo: e.target.value.slice(0, 2000) })}
            rows={4}
            className="mt-1 block w-full rounded-md border border-neutral-200 px-2 py-1 text-sm"
            placeholder="Reporting time, office address, who to ask for, what to bring."
          />
        </label>
      </Section>

      <Section
        title="Quiet hours"
        hint="Nothing is sent in this window; scheduled emails go out at 10:00 in this time zone."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.quietHours.enabled}
            onChange={(e) =>
              setS({ ...s, quietHours: { ...s.quietHours, enabled: e.target.checked } })
            }
          />
          Respect quiet hours
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          From
          <input
            type="number"
            min={0}
            max={23}
            value={s.quietHours.startHour}
            onChange={(e) =>
              setS({ ...s, quietHours: { ...s.quietHours, startHour: Number(e.target.value) } })
            }
            className={`${input} w-16`}
          />
          :00 to
          <input
            type="number"
            min={0}
            max={23}
            value={s.quietHours.endHour}
            onChange={(e) =>
              setS({ ...s, quietHours: { ...s.quietHours, endHour: Number(e.target.value) } })
            }
            className={`${input} w-16`}
          />
          :00, time zone
          <input
            value={s.quietHours.timezone}
            onChange={(e) =>
              setS({ ...s, quietHours: { ...s.quietHours, timezone: e.target.value } })
            }
            className={`${input} w-48`}
            placeholder="Asia/Kolkata"
          />
        </div>
      </Section>

      <Section
        title="Signals"
        hint="A signal is something the candidate said (in a reply, with their exact words) or a check-in answered “Not sure” / “No”. There is no risk score. Choose which are recorded and which alert the recruiter."
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-1">Signal</th>
              <th className="py-1">Record</th>
              <th className="py-1">Alert recruiter</th>
            </tr>
          </thead>
          <tbody>
            {RISK_SIGNAL_TYPES.map((t) => (
              <tr key={t} className="border-t border-neutral-100">
                <td className="py-1.5">
                  {RISK_SIGNAL_LABELS[t]}
                  {t in CLASSIFIER_SIGNAL_DEFINITIONS ? (
                    <div className="text-xs text-neutral-500">
                      {
                        CLASSIFIER_SIGNAL_DEFINITIONS[
                          t as keyof typeof CLASSIFIER_SIGNAL_DEFINITIONS
                        ]
                      }
                    </div>
                  ) : null}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={s.signals.enabled.includes(t)}
                    onChange={() => toggleSignal("enabled", t)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    disabled={!s.signals.enabled.includes(t)}
                    checked={s.signals.alertOn.includes(t) && s.signals.enabled.includes(t)}
                    onChange={() => toggleSignal("alertOn", t)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Renege reasons"
        hint="The list a recruiter picks from when a candidate backs out after accepting."
      >
        <ul className="space-y-1 text-sm">
          {s.renegeReasons.map((r) => (
            <li key={r.code} className="flex items-center gap-2">
              <span className="flex-1">{r.label}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={s.renegeReasons.length <= 1}
                onClick={() =>
                  setS({ ...s, renegeReasons: s.renegeReasons.filter((x) => x.code !== r.code) })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            className={`${input} flex-1`}
            placeholder="New reason"
            maxLength={80}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!newReason.trim()}
            onClick={() => {
              const code = newReason
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_|_$/g, "")
                .slice(0, 40);
              if (!code || s.renegeReasons.some((r) => r.code === code)) return;
              setS({
                ...s,
                renegeReasons: [...s.renegeReasons, { code, label: newReason.trim() }],
              });
              setNewReason("");
            }}
          >
            Add
          </Button>
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={save.isPending} onClick={() => save.mutate(s)}>
          Save settings
        </Button>
        <Button
          variant="secondary"
          disabled={!s.enabled || start.isPending}
          onClick={() => start.mutate({})}
        >
          Start for candidates who already accepted
        </Button>
        {msg ? <span className="text-sm text-neutral-600">{msg}</span> : null}
      </div>

      <Section
        title="Company updates"
        hint="Short news items the journey sends between check-ins — each candidate gets the next one they haven't had, in this order."
      >
        <ul className="space-y-2">
          {(updates.data?.items ?? []).map((u) => (
            <li
              key={u.id}
              className="flex items-start justify-between gap-3 rounded border border-neutral-100 p-2 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium text-neutral-900">
                  {u.title} {u.isActive ? null : <Badge>inactive</Badge>}
                </div>
                <div className="line-clamp-2 text-xs text-neutral-500">{u.body}</div>
                <div className="text-xs text-neutral-400">
                  Order {u.sortOrder} · sent {u.sentCount}×
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    id: u.id,
                    title: u.title,
                    body: u.body,
                    linkUrl: u.linkUrl ?? "",
                    videoUrl: u.videoUrl ?? "",
                    isActive: u.isActive,
                    sortOrder: u.sortOrder,
                  })
                }
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-neutral-100 pt-3">
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Title"
            className={`${input} w-full`}
            maxLength={200}
          />
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="Body"
            rows={4}
            className="w-full rounded-md border border-neutral-200 px-2 py-1 text-sm"
            maxLength={5000}
          />
          <div className="flex gap-2">
            <input
              value={draft.linkUrl}
              onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })}
              placeholder="Link URL (optional)"
              className={`${input} flex-1`}
            />
            <input
              value={draft.videoUrl}
              onChange={(e) => setDraft({ ...draft, videoUrl: e.target.value })}
              placeholder="Video URL (optional)"
              className={`${input} flex-1`}
            />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
              />
              Active
            </label>
            <label className="flex items-center gap-2">
              Order
              <input
                type="number"
                min={0}
                value={draft.sortOrder}
                onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
                className={`${input} w-20`}
              />
            </label>
            <Button
              size="sm"
              disabled={!draft.title.trim() || !draft.body.trim() || upsert.isPending}
              onClick={() =>
                upsert.mutate({
                  id: draft.id,
                  title: draft.title,
                  body: draft.body,
                  linkUrl: draft.linkUrl.trim() || null,
                  videoUrl: draft.videoUrl.trim() || null,
                  isActive: draft.isActive,
                  sortOrder: draft.sortOrder,
                })
              }
            >
              {draft.id ? "Save update" : "Add update"}
            </Button>
            {draft.id ? (
              <Button size="sm" variant="ghost" onClick={() => setDraft(EMPTY)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </Section>
    </PageContainer>
  );
}
