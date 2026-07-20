"use client";

import { useMemo, useState } from "react";
import {
  type ListNotificationLogOutput,
  type NotificationStatus,
  NOTIFICATION_STATUSES,
  NOTIFICATION_STATUS_META,
  EMAIL_TEMPLATE_REGISTRY,
} from "@hireops/api-types";
import {
  Badge,
  Card,
  EmptyState,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
  type BadgeTone,
} from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin Messaging (AD12) — email-only delivery log + real template registry.
 *
 * REFUSALS, made explicit on the page (a demo talking point): no WhatsApp/SMS
 * channel (we have none), no delivery/read receipts (the outbox tracks send
 * status only — pending → processing → sent | failed | cancelled). Everything
 * shown is the REAL notification_outbox and the REAL code-owned templates.
 */

export function MessagingClient({ initial }: { initial: ListNotificationLogOutput }) {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [templateKey, setTemplateKey] = useState<string>("");

  const query = trpc.listNotificationLog.useQuery(
    {
      limit: 100,
      ...(status ? { status } : {}),
      ...(templateKey ? { templateKey } : {}),
    },
    {
      initialData: status === null && templateKey === "" ? initial : undefined,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  );

  const data = query.data ?? initial;
  const items = data.items;

  const templatesByAudience = useMemo(() => {
    const groups: Record<string, typeof EMAIL_TEMPLATE_REGISTRY> = {};
    for (const t of EMAIL_TEMPLATE_REGISTRY) {
      (groups[t.audience] ??= []).push(t);
    }
    return groups;
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50/60 px-5 py-4">
        <p className="text-sm text-neutral-700">
          <span className="font-semibold text-neutral-900">Email is the only channel.</span> HireOps
          sends transactional email through the notification outbox (Resend behind config). There is
          deliberately no WhatsApp or SMS integration, and no delivery- or read-receipt tracking —
          the outbox records send <em>status</em> only. Everything below is real.
        </p>
      </div>

      {/* Status rollup — the whole-tenant outbox counts. */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total" value={data.total} tone="neutral" />
        {NOTIFICATION_STATUSES.map((s) => (
          <StatCard
            key={s}
            label={NOTIFICATION_STATUS_META[s].label}
            value={data.statusCounts?.[s] ?? 0}
            tone={NOTIFICATION_STATUS_META[s].tone}
          />
        ))}
      </section>

      <h2 className="mb-3 text-base font-semibold text-neutral-900">Delivery log</h2>

      {/* Filters. */}
      <section className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip label="All statuses" active={status === null} onClick={() => setStatus(null)} />
        {NOTIFICATION_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={NOTIFICATION_STATUS_META[s].label}
            active={status === s}
            onClick={() => setStatus((cur) => (cur === s ? null : s))}
          />
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-neutral-200" />
        <select
          value={templateKey}
          onChange={(e) => setTemplateKey(e.target.value)}
          aria-label="Filter by template"
          className="h-8 rounded-full border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All templates</option>
          {EMAIL_TEMPLATE_REGISTRY.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </section>

      {query.isLoading ? (
        <Card>
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : items.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No emails match"
            hint={
              status || templateKey
                ? "Clear the filters to see the full log."
                : "Sent and queued emails will appear here."
            }
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>When</Th>
            <Th>Recipient</Th>
            <Th>Template</Th>
            <Th>Subject</Th>
            <Th>Status</Th>
            <Th className="text-right">Attempts</Th>
          </Thead>
          <Tbody>
            {items.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap">
                  <span className="block text-neutral-800 tabular-nums">
                    {absolute(r.created_at)}
                  </span>
                  {r.sent_at ? (
                    <span className="block text-xs text-neutral-400">
                      sent {absolute(r.sent_at)}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block text-neutral-800">{r.recipient_email}</span>
                  <span className="block text-xs text-neutral-400">{r.recipient_type}</span>
                </Td>
                <Td>
                  <Badge tone="neutral" className="font-mono">
                    {templateLabel(r.template_key)}
                  </Badge>
                </Td>
                <Td className="max-w-xs">
                  <span className="block truncate text-neutral-700" title={r.subject ?? undefined}>
                    {r.subject ?? "—"}
                  </span>
                  {r.last_error ? (
                    <span
                      className="block truncate text-xs text-status-error-600"
                      title={r.last_error}
                    >
                      {r.last_error}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                </Td>
                <Td className="text-right tabular-nums text-neutral-600">{r.attempt_count}</Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      {/* The REAL template registry. */}
      <h2 className="mb-1 mt-10 text-base font-semibold text-neutral-900">Email templates</h2>
      <p className="mb-4 max-w-2xl text-sm text-neutral-600">
        These are the actual templates the delivery worker renders — code-owned in
        <span className="mx-1 font-mono text-xs text-neutral-500">@hireops/email-templates</span>
        and version-controlled. Copy is edited in code review, not from a settings screen, so a
        wrong-template send can never ship silently.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Object.entries(templatesByAudience).map(([audience, templates]) => (
          <Card key={audience} className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-neutral-900">{audience} emails</h3>
              <Badge tone="neutral">{templates.length}</Badge>
            </div>
            <ul className="space-y-3">
              {templates.map((t) => (
                <li
                  key={t.key}
                  className="border-t border-neutral-100 pt-3 first:border-0 first:pt-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-neutral-800">{t.label}</span>
                    <code className="text-[11px] text-neutral-400">{t.key}</code>
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500">{t.description}</p>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: BadgeTone }) {
  const accent =
    tone === "success"
      ? "text-status-positive-600"
      : tone === "error"
        ? "text-status-error-600"
        : tone === "warning"
          ? "text-status-warning-600"
          : tone === "info"
            ? "text-brand-600"
            : "text-neutral-900";
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent}`}>
        {value.toLocaleString()}
      </p>
    </Card>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
        active
          ? "bg-brand-600 text-white"
          : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
      }`}
    >
      {label}
    </button>
  );
}

function templateLabel(key: string): string {
  return EMAIL_TEMPLATE_REGISTRY.find((t) => t.key === key)?.label ?? key;
}

function isKnownStatus(s: string): s is NotificationStatus {
  return (NOTIFICATION_STATUSES as readonly string[]).includes(s);
}

function statusLabel(s: string): string {
  return isKnownStatus(s) ? NOTIFICATION_STATUS_META[s].label : s;
}

function statusTone(s: string): BadgeTone {
  return isKnownStatus(s) ? NOTIFICATION_STATUS_META[s].tone : "neutral";
}

function absolute(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
