"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  GetHrHeadDashboardExtrasOutput,
  DashboardAction,
  HrHeadKpi,
  HrHeadApprovalItem,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Card, StatTile } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import {
  PageHeader,
  HeroStatCard,
  StageFunnel,
  ActionTriad,
  AlertCard,
  PriorityChip,
  InboxIcon,
  ShieldIcon,
  ArrowDownIcon,
  ArrowUpIcon,
} from "@/components/patterns";

/**
 * HrHeadDashboard (HRHEAD-01) — the bespoke HR-head landing surface. Two
 * reads: getHrHeadDashboardExtras (KPIs + funnel + approvals + risk, rich) and
 * the getMyDashboard hr_head actions (the "Tasks due today" strip). Approvals
 * are decided inline via the existing decideRequisitionApproval; send-back and
 * reject open the ActionTriad's inline reason input. 2-col main + right rail,
 * matching the prototype's dashboard gestalt on OUR tokens.
 */

const ENFORCEMENT_META: Record<
  "off" | "warn" | "block",
  { severity: "critical" | "warning" | "info"; chip: string; line: string }
> = {
  off: {
    severity: "critical",
    chip: "off",
    line: "Bias gate is OFF — JD wording is not screened before approval.",
  },
  warn: {
    severity: "warning",
    chip: "warn",
    line: "Bias gate is in warn mode — flags recorded, submits proceed.",
  },
  block: {
    severity: "info",
    chip: "block",
    line: "Bias gate is enforcing — flagged submits are blocked.",
  },
};

function SiblingDelta({ kpi }: { kpi: HrHeadKpi }) {
  if (!kpi.delta) {
    return kpi.caption ? <span className="opacity-60">{kpi.caption}</span> : null;
  }
  const d = kpi.delta;
  const tone =
    d.tone === "good"
      ? "text-status-positive-700"
      : d.tone === "bad"
        ? "text-status-error-700"
        : "text-neutral-500";
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cn("inline-flex items-center gap-1 font-medium", tone)}>
        {d.direction === "down" ? (
          <ArrowDownIcon width={12} height={12} />
        ) : d.direction === "up" ? (
          <ArrowUpIcon width={12} height={12} />
        ) : null}
        {d.label}
        <span className="font-normal text-neutral-400">· {d.caption}</span>
      </span>
      {kpi.caption ? <span className="opacity-60">{kpi.caption}</span> : null}
    </span>
  );
}

function ApprovalRow({
  item,
  onDecide,
  pending,
}: {
  item: HrHeadApprovalItem;
  onDecide: (
    approvalRequestId: string,
    decision: "approve" | "send_back" | "reject",
    reason?: string,
  ) => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/requisitions/${item.requisitionId}`}
            className="truncate text-sm font-medium text-neutral-900 hover:text-brand-700 hover:underline"
          >
            {item.title ?? "Untitled requisition"}
          </a>
          <PriorityChip priority={item.priority} />
        </div>
        <p className="mt-0.5 text-xs text-neutral-500">
          {[
            item.department ?? null,
            item.budgetBand ?? null,
            item.requestedByName ? `by ${item.requestedByName}` : null,
            item.ageDays > 0 ? `${item.ageDays}d old` : "today",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {item.biasFlags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.biasFlags.map((f) => (
              <span
                key={`${f.term}-${f.category}`}
                title={f.suggestion ?? undefined}
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px]",
                  f.severity === "block"
                    ? "bg-status-error-50 text-status-error-700"
                    : "bg-status-warning-50 text-status-warning-800",
                )}
              >
                {f.term}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <ActionTriad
        pending={pending}
        onApprove={() => onDecide(item.approvalRequestId, "approve")}
        onSendBack={(reason) => onDecide(item.approvalRequestId, "send_back", reason)}
        onReject={(reason) => onDecide(item.approvalRequestId, "reject", reason)}
        className="shrink-0"
      />
    </div>
  );
}

export function HrHeadDashboard({
  initialExtras,
  tasks,
  displayName,
}: {
  initialExtras: GetHrHeadDashboardExtrasOutput;
  tasks: DashboardAction[];
  displayName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const extrasQuery = trpc.getHrHeadDashboardExtras.useQuery(undefined, {
    initialData: initialExtras,
  });
  const decide = trpc.decideRequisitionApproval.useMutation();
  const data = extrasQuery.data ?? initialExtras;

  const hero = data.kpis.find((k) => k.hero);
  const siblings = data.kpis.filter((k) => !k.hero);

  async function onDecide(
    approvalRequestId: string,
    decision: "approve" | "send_back" | "reject",
    reason?: string,
  ) {
    setError(null);
    try {
      await decide.mutateAsync({ approvalRequestId, decision, reason });
      await extrasQuery.refetch();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  const risk = data.risk;
  const enforcement = ENFORCEMENT_META[risk.biasGateEnforcement];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
      <PageHeader
        title={`Welcome back, ${displayName}`}
        subtitle="Your approvals, hiring health, and compliance at a glance."
      />

      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {/* KPI strip: hero (accent-filled) + white siblings. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {hero ? (
          <HeroStatCard
            label={hero.label}
            value={hero.value}
            caption={hero.caption}
            delta={hero.delta}
            href={hero.href}
            icon={<InboxIcon width={18} height={18} />}
          />
        ) : null}
        {siblings.map((k) => (
          <a
            key={k.key}
            href={k.href}
            className="rounded-card outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <StatTile
              label={k.label}
              value={k.value}
              hint={<SiblingDelta kpi={k} />}
              className="h-full transition-colors hover:border-neutral-300"
            />
          </a>
        ))}
      </div>

      {/* 2-col main + right rail. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Approvals pending, decide inline. */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">
              Approvals awaiting your decision
            </h2>
            {data.approvals.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">
                  Nothing awaiting a decision. New submissions land here to approve, send back, or
                  reject.
                </p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {data.approvals.map((item) => (
                    <ApprovalRow
                      key={item.approvalRequestId}
                      item={item}
                      onDecide={onDecide}
                      pending={decide.isPending}
                    />
                  ))}
                </div>
              </Card>
            )}
          </section>

          {/* Pipeline funnel. */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Pipeline</h2>
            <Card>
              <StageFunnel stages={data.funnel.stages} bottleneck={data.funnel.bottleneck} />
            </Card>
          </section>

          {/* Tasks due today (getMyDashboard actions restyled). */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Tasks due today</h2>
            {tasks.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">You&apos;re all caught up.</p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {tasks.map((t) => (
                    <a
                      key={t.key}
                      href={t.href}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-900">{t.label}</p>
                        {t.detail ? (
                          <p className="truncate text-xs text-neutral-500">{t.detail}</p>
                        ) : null}
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium lowercase",
                          t.urgency === "urgent"
                            ? "bg-status-error-50 text-status-error-700"
                            : t.urgency === "attention"
                              ? "bg-status-warning-50 text-status-warning-800"
                              : "bg-neutral-100 text-neutral-600",
                        )}
                      >
                        {t.urgency === "urgent"
                          ? "high"
                          : t.urgency === "attention"
                            ? "medium"
                            : "low"}
                      </span>
                    </a>
                  ))}
                </div>
              </Card>
            )}
          </section>
        </div>

        {/* Right rail: Risk & Compliance. */}
        <aside className="flex flex-col gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
            <ShieldIcon width={15} height={15} className="text-neutral-500" />
            Risk &amp; compliance
          </h2>
          <AlertCard
            severity={enforcement.severity}
            chip={enforcement.chip}
            entity="Bias-gate enforcement"
            consequence={enforcement.line}
            href="/admin/ai-settings"
          />
          {risk.staleApprovals > 0 ? (
            <AlertCard
              severity={risk.staleApprovals > 2 ? "critical" : "warning"}
              chip={`${risk.staleApprovals}`}
              entity="Approvals aging"
              consequence={`${risk.staleApprovals} approval${
                risk.staleApprovals === 1 ? "" : "s"
              } pending over 2 days.`}
              href="/requisition-approvals"
            />
          ) : (
            <AlertCard
              severity="info"
              chip="ok"
              entity="Approvals fresh"
              consequence="No approval has waited longer than 2 days."
            />
          )}
          {risk.belowBenchmark !== null ? (
            <AlertCard
              severity="warning"
              chip={`${risk.belowBenchmark}`}
              entity="Below benchmark"
              consequence={`${risk.belowBenchmark} req${
                risk.belowBenchmark === 1 ? "" : "s"
              } below the benchmark median.`}
            />
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong. Please try again.";
}
